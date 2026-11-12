import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { prisma, Prisma } from '@storeforge/db';
import { getMetaClient, MetaApiError, type CapiEvent } from './meta';
import { openToken } from './token-vault';
import { enqueueCapiDispatch } from '../jobs/queues';
import { ManagedConversions, refOf } from './managed/conversions';
import { getManagedChannel } from './managed/adapters';

export const MAX_CAPI_ATTEMPTS = 8;
const backoffMs = (attempts: number) => Math.min(6 * 3600_000, 60_000 * 2 ** Math.max(0, attempts - 1)); // 1m, 2m, 4m … 6h
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
/** Meta normalisation rules (customer-information-parameters), then SHA-256. Empty → omitted. */
export const norm = {
  email: (v?: string | null) => (v ? v.trim().toLowerCase() : ''),
  name: (v?: string | null) => (v ? v.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}\d]/gu, '') : ''),
  city: (v?: string | null) => (v ? v.normalize('NFKC').toLowerCase().replace(/[^\p{L}]/gu, '') : ''),
  state: (v?: string | null) => (v ? v.toLowerCase().replace(/[^a-z]/g, '').slice(0, 2) : ''),
  zip: (v?: string | null, country?: string | null) => {
    const z = (v ?? '').toLowerCase().replace(/[\s-]/g, '');
    return (country ?? '').toUpperCase() === 'US' ? z.slice(0, 5) : z;
  },
  country: (v?: string | null) => (v ? v.trim().toLowerCase().slice(0, 2) : ''),
};
const hashed = (v: string) => (v ? [sha(v)] : undefined);
export const eventIdFor = (orderId: string) => `order_${orderId}`;

type Attribution = { consent?: boolean; fbp?: string | null; fbc?: string | null; ip?: string | null; ua?: string | null; sourceUrl?: string | null };

/**
 * Meta Conversions API (blueprint: capi.dispatch, retry with dedupe by eventId).
 *
 * One ConversionEvent per paid order (eventId `order_<orderId>` is unique), only when the shop
 * has a Pixel selected and the shopper consented in the banner. The storefront Pixel fires the same
 * Purchase with eventID = the same id, so Meta keeps one of the pair. Customer data is normalised
 * and SHA-256 hashed; IP / user agent / fbp / fbc are sent as-is (Meta's rules).
 * While a Test Events code is set on the ad account, events carry test_event_code.
 */
@Injectable()
export class ConversionsService {
  private readonly logger = new Logger(ConversionsService.name);
  private readonly inflight = new Set<Promise<unknown>>();
  /** Managed Boost accounts (Meta managed CAPI, Google enhanced conversions, TikTok Events API) */
  readonly managed = new ManagedConversions();

  /** Tests: wait for background dispatches started by this instance. */
  async idle() {
    while (this.inflight.size) await Promise.all([...this.inflight]);
    await this.managed.idle();
  }

  private async accountFor(storeId: string) {
    const a = await prisma.adAccount.findUnique({ where: { storeId_channel_mode: { storeId, channel: 'META', mode: 'OWNED' } }, include: { connection: true } });
    return a && a.status === 'active' && a.pixelId ? a : null;
  }

  buildEvent(order: Prisma.OrderGetPayload<{ include: { lines: true } }>, attr: Attribution, eventTime: Date): CapiEvent {
    const [first, ...rest] = order.customerName.trim().split(/\s+/);
    const email = norm.email(order.customerEmail);
    return {
      event_name: 'Purchase',
      event_time: Math.floor(eventTime.getTime() / 1000),
      event_id: eventIdFor(order.id),
      action_source: 'website',
      ...(attr.sourceUrl ? { event_source_url: attr.sourceUrl } : {}),
      user_data: {
        em: hashed(email),
        fn: hashed(norm.name(first)),
        ln: hashed(norm.name(rest.at(-1))),
        ct: hashed(norm.city(order.shippingCity)),
        st: hashed(norm.state(order.shippingState)),
        zp: hashed(norm.zip(order.shippingPostalCode, order.shippingCountry)),
        country: hashed(norm.country(order.shippingCountry)),
        external_id: hashed(email),
        ...(attr.ip ? { client_ip_address: attr.ip } : {}),
        ...(attr.ua ? { client_user_agent: attr.ua } : {}),
        ...(attr.fbp ? { fbp: attr.fbp } : {}),
        ...(attr.fbc ? { fbc: attr.fbc } : {}),
      },
      custom_data: {
        currency: order.currency.toUpperCase(),
        value: Math.round(order.totalCents) / 100,
        content_ids: order.lines.map((l) => l.storeProductId),
        content_type: 'product',
        num_items: order.lines.reduce((a, l) => a + l.quantity, 0),
        order_id: order.id,
      },
    };
  }

  /** Called once per order when it becomes PAID. Never throws (payment flow must not depend on ads). */
  async orderPaid(orderId: string, eventTime = new Date()) {
    try {
      const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lines: true } });
      if (!order) return null;
      const account = await this.accountFor(order.storeId);
      const managed = await this.managed.accountsFor(order.storeId);
      if (!account && !managed.length) return null; // no Pixel and no managed Boost → nothing to send
      const attr = (order.attribution ?? {}) as Attribution;
      const base = { storeId: order.storeId, orderId, eventName: 'Purchase', eventId: eventIdFor(orderId), testEventCode: account?.testEventCode ?? null };
      let row;
      try {
        if (attr.consent !== true) {
          row = await prisma.conversionEvent.create({ data: { ...base, metaStatus: 'skipped', lastError: 'no_consent' } });
          return row;
        }
        // The hashed payload is kept even without an owned Pixel: managed deliveries are built from it.
        row = await prisma.conversionEvent.create({ data: { ...base, metaStatus: account ? 'pending' : 'skipped', lastError: account ? null : 'no_owned_pixel', payload: this.buildEvent(order, attr, eventTime) as any } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null; // already recorded (replay)
        throw e;
      }
      if (managed.length) await this.managed.createFor(row.id, managed);
      if (!account) return row;
      const q = await enqueueCapiDispatch(row.id);
      if (q.inline) {
        const p = this.dispatch(row.id).catch(() => null).finally(() => this.inflight.delete(p));
        this.inflight.add(p);
      }
      return row;
    } catch (e: any) {
      this.logger.error(`CAPI event for order ${orderId} not recorded: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * Sweeper (QA r3 #1): a crash between markPaid and orderPaid leaves a paid, consented order with
   * no ConversionEvent. Recreate it (same event_id, so still deduped with the browser Pixel), with
   * event_time = when the order was placed. Meta accepts website events up to 7 days old.
   */
  async sweepMissing(now = new Date(), graceMs = 2 * 60_000) {
    const accounts = await prisma.adAccount.findMany({ where: { OR: [{ channel: 'META', mode: 'OWNED', status: 'active', pixelId: { not: null } }, { mode: 'MANAGED', status: 'active', provisionStatus: 'ready', campaigns: { some: { launchedAt: { not: null } } } }] }, select: { storeId: true } });
    if (!accounts.length) return [];
    const orders = await prisma.order.findMany({
      where: {
        storeId: { in: accounts.map((a) => a.storeId) },
        status: { notIn: ['PENDING_PAYMENT', 'CANCELLED', 'FAILED'] },
        providerPaymentId: { not: null },
        attribution: { path: ['consent'], equals: true },
        createdAt: { gt: new Date(now.getTime() - 7 * 24 * 3600_000 + 3600_000) },
        updatedAt: { lt: new Date(now.getTime() - graceMs) },
      },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    if (!orders.length) return [];
    const have = new Set((await prisma.conversionEvent.findMany({ where: { eventId: { in: orders.map((o) => eventIdFor(o.id)) } }, select: { eventId: true } })).map((e) => e.eventId));
    const out: string[] = [];
    for (const o of orders) {
      if (have.has(eventIdFor(o.id))) continue;
      if (await this.orderPaid(o.id, o.createdAt)) out.push(o.id);
    }
    return out;
  }

  /**
   * capi.dispatch worker body. Claim = compare-and-set on attempts, so two workers can't both send
   * one attempt; a crash after Meta accepted it is harmless (Meta dedupes server events by event_id).
   * Throws on a retryable failure (BullMQ backs off); inline mode is retried by retryPending().
   */
  async dispatch(id: string): Promise<'sent' | 'retry' | 'failed' | 'skipped'> {
    const ev = await prisma.conversionEvent.findUnique({ where: { id } });
    if (!ev || ev.metaStatus !== 'pending' || !ev.payload) return 'skipped';
    const claim = await prisma.conversionEvent.updateMany({ where: { id, metaStatus: 'pending', attempts: ev.attempts }, data: { attempts: { increment: 1 } } });
    if (!claim.count) return 'skipped';
    const account = await this.accountFor(ev.storeId);
    const fail = async (reason: string) => {
      await prisma.conversionEvent.update({ where: { id }, data: { metaStatus: 'failed', lastError: reason.slice(0, 500) } });
      return 'failed' as const;
    };
    if (!account?.connection || account.connection.status !== 'active') return fail('Meta not connected');
    const payload = ev.payload as unknown as CapiEvent;
    if (payload.event_time * 1000 < Date.now() - 7 * 86_400_000) return fail('event older than 7 days (Meta rejects it)');
    try {
      const r = await getMetaClient().sendEvents(openToken(account.connection.tokenCipher), account.pixelId!, [payload], ev.testEventCode ?? account.testEventCode);
      await prisma.conversionEvent.update({ where: { id }, data: { metaStatus: 'sent', sentMeta: true, sentAt: new Date(), metaTrace: r.fbtrace_id, lastError: null } });
      return 'sent';
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (e instanceof MetaApiError && e.isAuth) {
        await prisma.adConnection.update({ where: { id: account.connection.id }, data: { status: 'expired', lastError: msg.slice(0, 500) } });
        return fail(`token: ${msg}`);
      }
      const transient = !(e instanceof MetaApiError) || e.isTransient;
      if (!transient || ev.attempts + 1 >= MAX_CAPI_ATTEMPTS) return fail(msg);
      await prisma.conversionEvent.update({ where: { id }, data: { lastError: msg.slice(0, 500) } });
      throw e;
    }
  }

  /** Sweeper for inline mode (and lost jobs): pending events past their backoff. */
  async retryPending(now = new Date()) {
    const rows = await prisma.conversionEvent.findMany({ where: { metaStatus: 'pending', updatedAt: { lt: new Date(now.getTime() - 60_000) } }, take: 100, select: { id: true, attempts: true, updatedAt: true } });
    const due = rows.filter((r) => now.getTime() - r.updatedAt.getTime() >= backoffMs(r.attempts));
    const out: { id: string; result: string }[] = [];
    for (const r of due) out.push({ id: r.id, result: await this.dispatch(r.id).catch((e) => `retry: ${e?.message ?? e}`) });
    return out;
  }

  /** Public, for the storefront thank-you page: what the browser Pixel needs. No PII. */
  async pixelForOrder(orderId: string) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.status === 'PENDING_PAYMENT' || order.createdAt.getTime() < Date.now() - 24 * 3600_000) throw new NotFoundException();
    const account = await this.accountFor(order.storeId);
    const tags = await this.managedTags(order.storeId);
    if (!account && !tags.length) throw new NotFoundException();
    // Google: transaction_id = order id (joins the server ENHANCEMENT); Meta/TikTok: event id order_<id>
    return { pixelId: account?.pixelId ?? null, eventId: eventIdFor(order.id), transactionId: order.id, value: order.totalCents / 100, currency: order.currency.toUpperCase(), stub: getMetaClient().mode === 'stub', tags };
  }

  /** Browser tags of the store's managed Boost accounts (Meta pixel / gtag AW- / TikTok pixel code) */
  async managedTags(storeId: string) {
    const accts = await this.managed.accountsFor(storeId);
    return accts.map((a) => ({ ...getManagedChannel(a.channel).browserTag(refOf(a)), stub: getManagedChannel(a.channel).mode === 'stub' })).filter((t): t is NonNullable<typeof t> & { kind: 'meta' | 'gtag' | 'tiktok'; id: string } => Boolean(t && (t as any).id));
  }

  /** Public, for every storefront page: is there a Pixel to load (after consent)? */
  async pixelForStore(storeId: string) {
    const a = await this.accountFor(storeId);
    const tags = await this.managedTags(storeId);
    return a || tags.length ? { pixelId: a?.pixelId ?? null, stub: getMetaClient().mode === 'stub', tags } : null;
  }

  /** Stub mode only: a managed tag's browser hit (gtag conversion / TikTok pixel / managed Meta pixel). */
  async recordManagedBrowserEvent(o: { kind: 'meta' | 'gtag' | 'tiktok'; id: string; eventName: string; eventId: string }) {
    const accts = await prisma.adAccount.findMany({ where: { mode: 'MANAGED', provisionStatus: 'ready', OR: [{ pixelId: o.id }, { conversionTag: { startsWith: o.id } }] } });
    const a = accts.find((x) => (o.kind === 'meta' ? x.channel === 'META' : o.kind === 'gtag' ? x.channel === 'GOOGLE' : x.channel === 'TIKTOK'));
    const ch = a ? getManagedChannel(a.channel) : null;
    if (!a || !ch || ch.mode !== 'stub' || !ch.recordBrowserEvent) throw new NotFoundException();
    ch.recordBrowserEvent(refOf(a), o.eventName, o.eventId);
    return { ok: true };
  }

  /** Stub mode only: the storefront's stand-in Pixel reports browser events here. */
  recordStubBrowserEvent(o: { pixelId: string; eventName: string; eventId: string }, testEventCode: string | null) {
    const m = getMetaClient() as any;
    if (m.mode !== 'stub' || typeof m.recordBrowserEvent !== 'function') throw new NotFoundException();
    m.recordBrowserEvent(o.pixelId, o.eventName, o.eventId, testEventCode);
    return { ok: true };
  }

  list(organizationId: string, storeId: string, take = 20) {
    return prisma.conversionEvent.findMany({
      where: { storeId, store: { organizationId } },
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, orderId: true, eventName: true, eventId: true, metaStatus: true, sentMeta: true, metaTrace: true, testEventCode: true, attempts: true, lastError: true, sentAt: true, createdAt: true },
    });
  }
}
