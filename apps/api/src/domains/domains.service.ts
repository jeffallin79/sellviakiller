import { randomBytes } from 'node:crypto';
import { Injectable, BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { prisma, DomainStatus, StoreStatus, type Domain } from '@storeforge/db';
import { validateCustomHost, InvalidHostError, normalizeHost, isApex, txtName, txtValue, wwwTwin, platformRoot } from './host';
import { getDns } from './dns';
import { getTls } from './tls';

export const MAX_DOMAINS_PER_STORE = 3;

export const cnameTarget = () => normalizeHost(process.env.DOMAIN_CNAME_TARGET ?? `stores.${platformRoot()}`);
export const apexIps = () =>
  (process.env.DOMAIN_APEX_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const dnsTimeoutMs = () => Number(process.env.DOMAIN_DNS_TIMEOUT_HOURS ?? 72) * 3600_000;
const tlsTimeoutMs = () => Number(process.env.DOMAIN_TLS_TIMEOUT_MIN ?? 30) * 60_000;

/**
 * DNS re-check cadence. Dense for the first 10 minutes (blueprint AC: verified with TLS < 10 min
 * once records are right), then backs off. TLS is polled every 15 s while issuing.
 */
export function nextDnsCheckDelayMs(windowAgeMs: number): number {
  if (windowAgeMs < 10 * 60_000) return 30_000;
  if (windowAgeMs < 60 * 60_000) return 2 * 60_000;
  return 15 * 60_000;
}
export const TLS_POLL_MS = 15_000;
export const ACTIVE_RECHECK_MS = 12 * 3600_000;

export type DnsRecordHint = { type: 'TXT' | 'CNAME' | 'A'; name: string; value: string; purpose: 'ownership' | 'routing'; ok: boolean | null; alternative?: boolean };
export type CheckResult = { txt: boolean; routing: boolean; tls: 'issued' | 'pending' | 'failed' | null; seen: { txt: string[]; cname: string[]; a: string[] }; detail?: string };

export type DomainView = Domain & {
  apex: boolean;
  records: DnsRecordHint[];
  dnsMode: 'live' | 'stub';
  tlsProvider: string;
  /** Seconds from DNS verification to TLS ready (AC metric), when both happened */
  tlsSeconds: number | null;
};

@Injectable()
export class DomainsService {
  private readonly logger = new Logger(DomainsService.name);

  config() {
    return {
      dnsMode: getDns().mode,
      tlsProvider: getTls().kind,
      cnameTarget: cnameTarget(),
      apexIps: apexIps(),
      maxPerStore: MAX_DOMAINS_PER_STORE,
      dnsTimeoutHours: dnsTimeoutMs() / 3600_000,
    };
  }

  view(d: Domain): DomainView {
    const apex = isApex(d.host);
    const last = (d.lastResult ?? null) as CheckResult | null;
    const records: DnsRecordHint[] = [
      { type: 'TXT', name: txtName(d.host), value: txtValue(d.verificationToken), purpose: 'ownership', ok: last ? last.txt : null },
    ];
    if (apex) {
      const ips = apexIps();
      for (const ip of ips) records.push({ type: 'A', name: d.host, value: ip, purpose: 'routing', ok: last ? last.routing : null });
      records.push({ type: 'CNAME', name: d.host, value: cnameTarget(), purpose: 'routing', ok: last ? last.routing : null, alternative: ips.length > 0 });
    } else {
      records.push({ type: 'CNAME', name: d.host, value: cnameTarget(), purpose: 'routing', ok: last ? last.routing : null });
    }
    const tlsSeconds = d.verifiedAt && d.tlsIssuedAt ? Math.round((d.tlsIssuedAt.getTime() - d.verifiedAt.getTime()) / 1000) : null;
    return { ...d, apex, records, dnsMode: getDns().mode, tlsProvider: d.tlsProvider, tlsSeconds };
  }

  private async ownedStore(organizationId: string, storeId: string) {
    const store = await prisma.store.findFirst({ where: { id: storeId, organizationId, deletedAt: null } });
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }
  private async owned(organizationId: string, id: string) {
    const d = await prisma.domain.findFirst({ where: { id, store: { organizationId } } });
    if (!d) throw new NotFoundException('Domain not found');
    return d;
  }

  async list(organizationId: string, storeId?: string) {
    const rows = await prisma.domain.findMany({
      where: { store: { organizationId, deletedAt: null }, ...(storeId ? { storeId } : {}) },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map((d) => this.view(d));
  }

  async add(organizationId: string, storeId: string, rawHost: string) {
    const store = await this.ownedStore(organizationId, storeId);
    let host: string;
    try {
      host = validateCustomHost(rawHost);
    } catch (e) {
      if (e instanceof InvalidHostError) throw new BadRequestException(e.message);
      throw e;
    }
    const existing = await prisma.domain.findUnique({ where: { host } });
    if (existing) {
      if (existing.storeId === store.id) return this.view(existing);
      throw new ConflictException('That domain is already connected to another store');
    }
    const count = await prisma.domain.count({ where: { storeId: store.id } });
    if (count >= MAX_DOMAINS_PER_STORE) throw new BadRequestException(`A store can have up to ${MAX_DOMAINS_PER_STORE} domains`);
    try {
      const d = await prisma.domain.create({
        data: {
          storeId: store.id,
          host,
          verificationToken: randomBytes(12).toString('hex'),
          isPrimary: count === 0,
          tlsProvider: getTls().kind,
        },
      });
      return this.view(d);
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('That domain is already connected to another store');
      throw e;
    }
  }

  /** Manual path: "Check now" (also restarts a FAILED domain's wait window). */
  async checkNow(organizationId: string, id: string, now = new Date()) {
    const d = await this.owned(organizationId, id);
    if (d.status === DomainStatus.FAILED) {
      await prisma.domain.update({
        where: { id },
        data: { status: d.verifiedAt ? DomainStatus.ISSUING_TLS : DomainStatus.PENDING_DNS, windowStartedAt: now, tlsRequestedAt: d.verifiedAt ? now : null, lastError: null },
      });
    }
    return this.view(await this.check(id, now));
  }

  /** Dev/stub only: pretend the merchant added the records. Refused in live DNS mode. */
  async simulateDns(organizationId: string, id: string, now = new Date()) {
    if (getDns().mode !== 'stub') throw new BadRequestException('DNS simulation is only available in dev (DOMAIN_DNS_MODE=stub)');
    await this.owned(organizationId, id);
    await prisma.domain.update({ where: { id }, data: { devDnsSimulatedAt: now } });
    return this.checkNow(organizationId, id, now);
  }

  async makePrimary(organizationId: string, id: string) {
    const d = await this.owned(organizationId, id);
    await prisma.$transaction([
      prisma.domain.updateMany({ where: { storeId: d.storeId }, data: { isPrimary: false } }),
      prisma.domain.update({ where: { id }, data: { isPrimary: true } }),
    ]);
    await this.syncStoreDomain(d.storeId);
    return this.list(organizationId, d.storeId);
  }

  async remove(organizationId: string, id: string) {
    const d = await this.owned(organizationId, id);
    await getTls().remove(d.host).catch((e) => this.logger.warn(`TLS remove ${d.host}: ${e?.message ?? e}`));
    await prisma.domain.delete({ where: { id } });
    if (d.isPrimary) {
      const next =
        (await prisma.domain.findFirst({ where: { storeId: d.storeId, status: DomainStatus.ACTIVE }, orderBy: { createdAt: 'asc' } })) ??
        (await prisma.domain.findFirst({ where: { storeId: d.storeId }, orderBy: { createdAt: 'asc' } }));
      if (next) await prisma.domain.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    await this.syncStoreDomain(d.storeId);
    return { removed: true };
  }

  /** Store.customDomain mirrors the primary ACTIVE host (used for links) — null otherwise. */
  private async syncStoreDomain(storeId: string) {
    const primary = await prisma.domain.findFirst({ where: { storeId, isPrimary: true, status: DomainStatus.ACTIVE } });
    await prisma.store.update({ where: { id: storeId }, data: { customDomain: primary?.host ?? null } });
  }

  /**
   * The state machine. Idempotent; safe to run any time.
   *   PENDING_DNS --(TXT + routing ok)--> ISSUING_TLS --(cert issued)--> ACTIVE
   *   PENDING_DNS --(no DNS within DOMAIN_DNS_TIMEOUT_HOURS)--> FAILED
   *   ISSUING_TLS --(provider error | DOMAIN_TLS_TIMEOUT_MIN)--> FAILED
   */
  async check(id: string, now = new Date()): Promise<Domain> {
    const d = await prisma.domain.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Domain not found');
    const dns = getDns();
    const tls = getTls();
    const expectedTxt = txtValue(d.verificationToken);
    const target = cnameTarget();
    const ips = apexIps();

    const base = { lastCheckedAt: now, checkCount: { increment: 1 } } as const;

    if (d.status === DomainStatus.FAILED) return d;

    if (d.status === DomainStatus.PENDING_DNS || d.status === DomainStatus.ACTIVE) {
      const snap = await dns.lookup(d.host, { devDnsSimulatedAt: d.devDnsSimulatedAt, expectedTxt, expectedTarget: target, apexIps: ips });
      const txtOk = snap.txt.some((v) => v.trim() === expectedTxt);
      let routingOk = snap.cname.includes(target) || (ips.length > 0 && snap.a.some((a) => ips.includes(a)));
      if (!routingOk && snap.a.length && dns.mode === 'live') {
        // ALIAS / ANAME / CNAME flattening: apex A records equal the target's A records
        const targetA = await dns.resolveA(target);
        routingOk = targetA.length > 0 && snap.a.every((a) => targetA.includes(a));
      }
      const result: CheckResult = { txt: txtOk, routing: routingOk, tls: d.status === DomainStatus.ACTIVE ? 'issued' : null, seen: snap };

      if (d.status === DomainStatus.ACTIVE) {
        // Never flap a live store offline on one bad lookup; surface the warning instead.
        return prisma.domain.update({
          where: { id },
          data: { ...base, lastResult: result as any, lastError: routingOk ? null : 'Routing record no longer points to StoreForge — your store may stop loading on this domain.', nextCheckAt: new Date(now.getTime() + ACTIVE_RECHECK_MS) },
        });
      }

      if (txtOk && routingOk) {
        const t = await tls.request(d.host).catch((e): { state: 'pending'; detail: string } => ({ state: 'pending', detail: String(e?.message ?? e) }));
        result.tls = t.state;
        result.detail = t.detail;
        const updated = await prisma.domain.update({
          where: { id },
          data: {
            ...base,
            status: t.state === 'issued' ? DomainStatus.ACTIVE : t.state === 'failed' ? DomainStatus.FAILED : DomainStatus.ISSUING_TLS,
            verifiedAt: now,
            tlsRequestedAt: now,
            tlsIssuedAt: t.state === 'issued' ? now : null,
            tlsProvider: tls.kind,
            lastResult: result as any,
            lastError: t.state === 'failed' ? `Certificate request failed: ${t.detail ?? 'unknown error'}` : null,
            nextCheckAt: new Date(now.getTime() + (t.state === 'issued' ? ACTIVE_RECHECK_MS : TLS_POLL_MS)),
          },
        });
        if (updated.status === DomainStatus.ACTIVE) await this.syncStoreDomain(d.storeId);
        return updated;
      }

      const age = now.getTime() - d.windowStartedAt.getTime();
      if (age >= dnsTimeoutMs()) {
        return prisma.domain.update({
          where: { id },
          data: { ...base, status: DomainStatus.FAILED, lastResult: result as any, lastError: `We couldn't see the DNS records after ${Math.round(dnsTimeoutMs() / 3600_000)} hours. Check them at your DNS host, then press Check again.` },
        });
      }
      const missing = [!txtOk && 'TXT', !routingOk && (isApex(d.host) ? 'A/ALIAS' : 'CNAME')].filter(Boolean).join(' and ');
      return prisma.domain.update({
        where: { id },
        data: { ...base, lastResult: result as any, lastError: `Waiting for the ${missing} record${missing.includes(' and ') ? 's' : ''}. DNS changes can take a few minutes to show up.`, nextCheckAt: new Date(now.getTime() + nextDnsCheckDelayMs(age)) },
      });
    }

    // ISSUING_TLS
    const t = await tls.status(d.host, { tlsRequestedAt: d.tlsRequestedAt, now }).catch((e): { state: 'pending'; detail: string } => ({ state: 'pending', detail: String(e?.message ?? e) }));
    const prev = (d.lastResult ?? {}) as Partial<CheckResult>;
    const result = { ...prev, tls: t.state, detail: t.detail } as CheckResult;
    if (t.state === 'issued') {
      const updated = await prisma.domain.update({
        where: { id },
        data: { ...base, status: DomainStatus.ACTIVE, tlsIssuedAt: now, lastResult: result as any, lastError: null, nextCheckAt: new Date(now.getTime() + ACTIVE_RECHECK_MS) },
      });
      await this.syncStoreDomain(d.storeId);
      return updated;
    }
    const waited = d.tlsRequestedAt ? now.getTime() - d.tlsRequestedAt.getTime() : 0;
    if (t.state === 'failed' || waited >= tlsTimeoutMs()) {
      return prisma.domain.update({
        where: { id },
        data: { ...base, status: DomainStatus.FAILED, lastResult: result as any, lastError: `Certificate wasn't issued${t.detail ? ` (${t.detail})` : ''}. Make sure no CAA record blocks Let's Encrypt, then press Check again.` },
      });
    }
    return prisma.domain.update({
      where: { id },
      data: { ...base, lastResult: result as any, lastError: null, nextCheckAt: new Date(now.getTime() + TLS_POLL_MS) },
    });
  }

  /** Background sweep. Each due row is claimed with a compare-and-set so parallel API instances don't double-check. */
  async sweepDue(now = new Date(), limit = 25) {
    const due = await prisma.domain.findMany({
      where: { status: { in: [DomainStatus.PENDING_DNS, DomainStatus.ISSUING_TLS, DomainStatus.ACTIVE] }, nextCheckAt: { lte: now } },
      orderBy: { nextCheckAt: 'asc' },
      take: limit,
    });
    let checked = 0;
    for (const d of due) {
      const claim = await prisma.domain.updateMany({
        where: { id: d.id, nextCheckAt: d.nextCheckAt },
        data: { nextCheckAt: new Date(now.getTime() + 60_000) }, // lease; check() sets the real next time
      });
      if (claim.count !== 1) continue;
      try {
        await this.check(d.id, now);
        checked++;
      } catch (e: any) {
        this.logger.warn(`domain check ${d.host}: ${e?.message ?? e}`);
      }
    }
    return { checked };
  }

  /**
   * Host → store for the storefront middleware.
   *   <slug>.<root>          → that store
   *   ACTIVE custom domain   → its store
   *   www twin of an ACTIVE domain → redirect to the registered host
   * Anything else (unverified, failed, unknown) → null (404). Never serves before verification.
   */
  async resolveHost(rawHost: string): Promise<{ slug: string; storeId: string; name: string; host: string; kind: 'subdomain' | 'custom'; redirectTo?: string } | null> {
    const host = normalizeHost(rawHost);
    if (!host) return null;
    const root = platformRoot();
    if (host.endsWith(`.${root}`)) {
      const slug = host.slice(0, -root.length - 1);
      if (!slug || slug.includes('.') || ['www', 'admin', 'api', 'stores'].includes(slug)) return null;
      const store = await prisma.store.findFirst({ where: { slug, deletedAt: null, status: StoreStatus.ACTIVE } });
      return store ? { slug: store.slug, storeId: store.id, name: store.name, host, kind: 'subdomain', ...(store.customDomain ? { redirectTo: store.customDomain } : {}) } : null;
    }
    const find = (h: string) =>
      prisma.domain.findFirst({ where: { host: h, status: DomainStatus.ACTIVE, store: { deletedAt: null, status: StoreStatus.ACTIVE } }, include: { store: true } });
    const d = await find(host);
    if (d) {
      // Secondary domains redirect to the primary so search engines see one canonical host.
      const redirectTo = !d.isPrimary && d.store.customDomain && d.store.customDomain !== host ? d.store.customDomain : undefined;
      return { slug: d.store.slug, storeId: d.storeId, name: d.store.name, host, kind: 'custom', ...(redirectTo ? { redirectTo } : {}) };
    }
    const twin = await find(wwwTwin(host));
    if (twin) return { slug: twin.store.slug, storeId: twin.storeId, name: twin.store.name, host, kind: 'custom', redirectTo: twin.store.customDomain ?? twin.host };
    return null;
  }

  /** Caddy on_demand_tls `ask`: 200 only for hosts whose DNS we verified (stops cert abuse). */
  async tlsAllowed(rawHost: string): Promise<boolean> {
    const host = normalizeHost(rawHost);
    const d = await prisma.domain.findFirst({
      where: { host: { in: [host, wwwTwin(host)] }, status: { in: [DomainStatus.ISSUING_TLS, DomainStatus.ACTIVE] }, store: { deletedAt: null } },
    });
    return Boolean(d);
  }

  /**
   * Where a store lives publicly. origin + shopPath = the shop home.
   *   primary ACTIVE domain → https://shop.example.com + "/"
   *   STOREFRONT_URL set    → STOREFRONT_URL + "/s/<slug>"
   *   otherwise             → http://<slug>.<root>:3000 + "/"
   */
  static async storeUrls(store: { id: string; slug: string; customDomain?: string | null }): Promise<{ origin: string; shopPath: string; custom: boolean }> {
    const host = store.customDomain ?? (await prisma.domain.findFirst({ where: { storeId: store.id, isPrimary: true, status: DomainStatus.ACTIVE } }))?.host;
    if (host) return { origin: `https://${host}`, shopPath: '/', custom: true };
    if (process.env.STOREFRONT_URL) return { origin: process.env.STOREFRONT_URL.replace(/\/$/, ''), shopPath: `/s/${store.slug}`, custom: false };
    return { origin: `http://${store.slug}.${platformRoot()}:3000`, shopPath: '/', custom: false };
  }
}
