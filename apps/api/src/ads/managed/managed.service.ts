import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { prisma, Prisma, type AdAccount, type AdCampaign, type AdChannel } from '@storeforge/db';
import { AdWalletService } from '../wallet.service';
import { BoostService } from '../boost.service';
import { fuelEvents } from '../fuel-events';
import { NotificationsService } from '../../payments/notifications.service';
import { DomainsService } from '../../domains/domains.service';
import { feeFor, feePct, MAX_DAILY_CENTS, STEADY_PURCHASES_7D } from '../ads.config';
import { getManagedChannel } from './adapters';
import { refOf } from './conversions';
import { CreativeService, type Variant } from './creative.service';
import { PolicyService, type PolicyResult } from './policy.service';
import { CAP_LEASE_MS, CHANNEL_MIN_CENTS, enabledChannels, LADDER, LAUNCH_LEASE_MS, LAUNCH_TARGET_MS, minTotalFor, PROVISION_LEASE_MS, RECONCILE_ALERT_BPS, RECONCILE_DAYS, splitBudget } from './config';
import { CHANNEL_LABEL, CHANNELS, PlatformError, type AccountRef, type Channel, type LaunchInput } from './types';

const DAY = 86_400_000;
const day = (d: Date) => d.toISOString().slice(0, 10);
const LIVE = ['REVIEW', 'WARMING', 'STEADY'] as const;
const ORDER: Channel[] = ['META', 'GOOGLE', 'TIKTOK'];
const sortCh = (c: Channel[]) => ORDER.filter((x) => c.includes(x));
type VariantP = Variant & { policy: PolicyResult };
type Acct = AdAccount;

/**
 * Managed Boost (blueprint slice 4): ads run in StoreForge-owned accounts (Meta Business Manager ad
 * account, Google Ads client under our MCC, TikTok Business Center advertiser), one per store per
 * channel, paid by the platform and re-charged to the org's Ad Fuel as spend + ADS_FEE_PCT (15%).
 *
 * Money safety:
 *   - charges: AdWalletService.chargeDay deltas per campaign-day (idempotent, row-locked, never < 0)
 *   - float:   every managed account carries a platform-side lifetime ceiling (Meta spend_cap /
 *              Google account budget / TikTok prepaid balance) = spent + its share of the fuel we
 *              can still collect: floor((fuel − uncharged·(1+fee)) / (1+fee)). Recomputed after
 *              every charge, top-up, launch and budget change, under a per-account lease with a
 *              dirty flag so concurrent triggers coalesce instead of racing.
 *   - low fuel: fuel can't cover a charge → every managed campaign on every channel pauses; top-up
 *              resumes them. Runway under a day → a heads-up notice.
 *   - launch:  needs one day of budget + fee in fuel; single-flight (group status CAS + per-campaign
 *              lease); each platform id saved as soon as it exists and timed-out creates are found by
 *              their [sf:<id>] tag, so retries resume without duplicates.
 *   - reconcile (02:00 UTC): days D-1…D-7 vs platform; any drift is charged to the platform's
 *              number (AdReconcile), > 1% raises an alert; unknown account-level spend alerts ops.
 */
@Injectable()
export class ManagedBoostService {
  private readonly logger = new Logger(ManagedBoostService.name);
  private readonly notifications = new NotificationsService();
  readonly policy = new PolicyService();
  readonly creative = new CreativeService();
  readonly inflight = new Set<Promise<unknown>>();
  constructor(private readonly wallet: AdWalletService = new AdWalletService(), private readonly boost: BoostService = new BoostService(wallet)) {}

  async idle() { while (this.inflight.size) await Promise.all([...this.inflight]); }
  private bg(p: Promise<unknown>) {
    const q = p.catch((e) => this.logger.warn(String(e?.message ?? e))).finally(() => this.inflight.delete(q));
    this.inflight.add(q);
  }

  /** Fuel signals for both Boost modes (replaces BoostService.listen): one notice per episode. */
  listen() {
    fuelEvents.on('empty', (walletId: string) => this.bg(this.onFuelEmpty(walletId)));
    fuelEvents.on('added', (walletId: string) => this.bg(this.onFuelAdded(walletId)));
  }

  private ch(c: Channel | AdChannel) { return getManagedChannel(c as Channel); }
  private async store(organizationId: string, storeId: string) {
    const s = await prisma.store.findFirst({ where: { id: storeId, organizationId, deletedAt: null } });
    if (!s) throw new NotFoundException('Store not found');
    return s;
  }
  private async fuel(organizationId: string) {
    const w = await this.wallet.walletFor(organizationId);
    const open = await prisma.adChargeDay.aggregate({ where: { walletId: w.id, shortfallCents: { gt: 0 } }, _sum: { shortfallCents: true } });
    const shortfall = open._sum.shortfallCents ?? 0;
    return { wallet: w, availableCents: Math.max(0, w.balanceCents + w.bonusCents - shortfall), shortfallCents: shortfall };
  }

  // ------------------------------------------------------------------ accounts
  async enable(organizationId: string, storeId: string, channels: Channel[]) {
    const store = await this.store(organizationId, storeId);
    const allowed = enabledChannels();
    const want = sortCh(channels.filter((c) => allowed.includes(c)));
    if (!want.length) throw new BadRequestException('Pick at least one channel');
    const ids: string[] = [];
    for (const channel of want) {
      const key = `sf-acct-${store.id}-${channel.toLowerCase()}`;
      const a = await prisma.adAccount.upsert({
        where: { storeId_channel_mode: { storeId, channel, mode: 'MANAGED' } },
        create: { storeId, channel, mode: 'MANAGED', externalId: `pending:${key}`, name: `${store.name} [sf:${key}]`, provisionKey: key, provisionStatus: 'provisioning', timezone: process.env.ADS_MANAGED_TIMEZONE ?? 'America/New_York' },
        update: { status: 'active' },
      });
      ids.push(a.id);
    }
    await Promise.all(ids.map((id) => this.provision(id)));
    return this.overview(organizationId, storeId);
  }

  /** Idempotent + resumable: find-by-key first, each created id saved at once; lease stops two runs. */
  async provision(accountId: string, now = new Date()) {
    const claim = await prisma.adAccount.updateMany({
      where: { id: accountId, mode: 'MANAGED', provisionStatus: { in: ['provisioning', 'failed'] }, OR: [{ provisionLockedUntil: null }, { provisionLockedUntil: { lt: now } }] },
      data: { provisionLockedUntil: new Date(now.getTime() + PROVISION_LEASE_MS) },
    });
    if (!claim.count) return prisma.adAccount.findUniqueOrThrow({ where: { id: accountId } });
    const a = await prisma.adAccount.findUniqueOrThrow({ where: { id: accountId }, include: { store: true } });
    const { origin } = await DomainsService.storeUrls(a.store);
    const prev: Partial<AccountRef> = { ...refOf(a), externalId: a.externalId.startsWith('pending:') ? undefined : a.externalId };
    const save = async (p: Partial<AccountRef>) => {
      const data: Prisma.AdAccountUpdateInput = {};
      for (const k of ['externalId', 'merchantCenterId', 'dataSourceId', 'catalogId', 'pixelId', 'pageId', 'conversionActionId', 'conversionTag', 'billingRef'] as const) if (p[k] !== undefined) (data as any)[k] = p[k];
      await prisma.adAccount.update({ where: { id: accountId }, data });
    };
    try {
      const r = await this.ch(a.channel).provision({ key: a.provisionKey!, storeName: a.store.name, currency: a.currency, timezone: a.timezone ?? 'America/New_York', country: 'US', siteUrl: origin }, prev, save);
      await save(r); // every ref the adapter returned (e.g. Meta page id) is persisted
      return await prisma.adAccount.update({ where: { id: accountId }, data: { externalId: r.externalId, name: r.name, provisionStatus: r.status === 'ready' ? 'ready' : 'pending_review', lastError: null, provisionLockedUntil: null } });
    } catch (e: any) {
      const transient = !(e instanceof PlatformError) || e.isTransient;
      this.logger.warn(`provision ${a.channel} for ${a.storeId}: ${e?.message ?? e}`);
      return prisma.adAccount.update({ where: { id: accountId }, data: { provisionStatus: transient ? 'provisioning' : 'failed', lastError: String(e?.message ?? e).slice(0, 500), provisionLockedUntil: null } });
    }
  }
  /** Scheduler: retry accounts still provisioning (transient failure / crash). */
  async provisionPending(now = new Date()) {
    const rows = await prisma.adAccount.findMany({ where: { mode: 'MANAGED', provisionStatus: 'provisioning', OR: [{ provisionLockedUntil: null }, { provisionLockedUntil: { lt: now } }] }, select: { id: true }, take: 50 });
    for (const r of rows) await this.provision(r.id, now);
    return rows.map((r) => r.id);
  }

  // ------------------------------------------------------------------ drafts
  private async productFor(storeId: string, storeProductId: string) {
    const sp = await prisma.storeProduct.findFirst({ where: { id: storeProductId, storeId, active: true, deletedAt: null }, include: { product: true, store: true } });
    if (!sp) throw new NotFoundException('Product not found in this store');
    return sp;
  }
  private scanVariant(sp: Awaited<ReturnType<ManagedBoostService['productFor']>>, v: Variant, https: boolean) {
    return this.policy.scan({
      title: sp.title ?? sp.product.title, category: sp.product.category,
      texts: [{ field: 'headline', text: v.headline }, { field: 'body', text: v.body }, ...v.headlines.map((h) => ({ field: 'headlines', text: h })), { field: 'longHeadline', text: v.longHeadline }, ...v.descriptions.map((d) => ({ field: 'descriptions', text: d }))],
      landing: { priceCents: sp.priceCents, etaDaysMin: sp.product.etaDaysMin, etaDaysMax: sp.product.etaDaysMax, https },
    });
  }
  private readyChannels(accts: Acct[]) { return sortCh(accts.filter((a) => a.provisionStatus === 'ready' && a.status === 'active').map((a) => a.channel as Channel)); }

  async createDraft(organizationId: string, storeId: string, o: { storeProductId: string; requestId: string }) {
    const store = await this.store(organizationId, storeId);
    const existing = await prisma.boostGroup.findUnique({ where: { storeId_requestId: { storeId, requestId: o.requestId } } });
    if (existing) return this.groupView(existing.id);
    const sp = await this.productFor(storeId, o.storeProductId);
    const { origin } = await DomainsService.storeUrls(store);
    const https = origin.startsWith('https://');
    const variants: VariantP[] = this.creative.writer.variants({ title: sp.title ?? sp.product.title, description: sp.product.description, priceCents: sp.priceCents, currency: 'USD', etaDaysMin: sp.product.etaDaysMin, etaDaysMax: sp.product.etaDaysMax, storeName: store.name, category: sp.product.category })
      .map((v) => ({ ...v, policy: this.scanVariant(sp, v, https) }));
    const accts = await prisma.adAccount.findMany({ where: { storeId, mode: 'MANAGED' } });
    const channels = this.readyChannels(accts);
    const total = channels.length ? Math.max(minTotalFor(channels), channels.includes('TIKTOK') ? 3000 : 1500) : 1500;
    const first = variants.findIndex((v) => v.policy.result !== 'block');
    const idx = first < 0 ? 0 : first;
    try {
      const g = await prisma.boostGroup.create({
        data: { storeId, storeProductId: sp.id, requestId: o.requestId, channels, dailyBudgetCents: total, split: splitBudget(total, channels), variants: variants as any, assets: this.creative.cropsFor(sp.id) as any, variantIndex: idx, policyResult: variants[idx].policy.result, pickedAt: new Date() },
      });
      await this.policy.record(g.id, variants[idx].policy);
      return this.groupView(g.id);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const g = await prisma.boostGroup.findUniqueOrThrow({ where: { storeId_requestId: { storeId, requestId: o.requestId } } });
        return this.groupView(g.id);
      }
      throw e;
    }
  }

  private async group(organizationId: string, groupId: string) {
    const g = await prisma.boostGroup.findFirst({ where: { id: groupId, store: { organizationId } }, include: { store: true, campaigns: { include: { adAccount: true } } } });
    if (!g) throw new NotFoundException('Boost not found');
    return g;
  }

  async updateDraft(organizationId: string, groupId: string, p: { variantIndex?: number; headline?: string; body?: string; channels?: Channel[]; dailyBudgetCents?: number }) {
    const g = await this.group(organizationId, groupId);
    if (!['DRAFT', 'FAILED'].includes(g.status)) throw new ConflictException('This Boost is already launched; change its budget or pause it instead');
    const variants = g.variants as unknown as VariantP[];
    let idx = p.variantIndex ?? g.variantIndex;
    if (idx < 0 || idx >= variants.length) throw new BadRequestException('Unknown variant');
    const data: Prisma.BoostGroupUpdateInput = { variantIndex: idx };
    if (p.headline !== undefined || p.body !== undefined) {
      const sp = await this.productFor(g.storeId, g.storeProductId);
      const { origin } = await DomainsService.storeUrls(g.store);
      const v = { ...variants[idx], ...(p.headline !== undefined ? { headline: p.headline.slice(0, 40), headlines: [p.headline.slice(0, 30), ...variants[idx].headlines.slice(1)] } : {}), ...(p.body !== undefined ? { body: p.body.slice(0, 125) } : {}), angle: 'custom' };
      const policy = this.scanVariant(sp, v, origin.startsWith('https://'));
      variants[idx] = { ...v, policy };
      data.variants = variants as any;
      await this.policy.record(g.id, policy);
    }
    data.policyResult = variants[idx].policy.result;
    const channels = p.channels ? sortCh(p.channels) : (g.channels as Channel[]);
    const total = p.dailyBudgetCents ?? g.dailyBudgetCents;
    if (p.channels) data.channels = channels;
    if (p.channels || p.dailyBudgetCents !== undefined) { data.dailyBudgetCents = total; data.split = splitBudget(total, channels); }
    idx = idx; // eslint
    await prisma.boostGroup.update({ where: { id: groupId }, data });
    return this.groupView(groupId);
  }

  // ------------------------------------------------------------------ launch
  async launch(organizationId: string, groupId: string) {
    const g = await this.group(organizationId, groupId);
    if (['LAUNCHING', 'LIVE', 'PAUSED'].includes(g.status)) return this.groupView(groupId); // double click
    const variants = g.variants as unknown as VariantP[];
    const v = variants[g.variantIndex];
    if (g.policyResult === 'block' || v.policy.result === 'block') throw new BadRequestException({ message: 'Fix the flagged text before launching', findings: v.policy.findings.filter((f) => f.level === 'block') });
    const channels = g.channels as Channel[];
    if (!channels.length) throw new BadRequestException('Pick at least one channel');
    const accts = await prisma.adAccount.findMany({ where: { storeId: g.storeId, mode: 'MANAGED', channel: { in: channels } } });
    for (const c of channels) {
      const a = accts.find((x) => x.channel === c);
      if (!a || a.provisionStatus !== 'ready' || a.status !== 'active') throw new ConflictException(`${CHANNEL_LABEL[c]} account isn't ready yet${a?.lastError ? `: ${a.lastError}` : ''}`);
    }
    const min = minTotalFor(channels);
    if (g.dailyBudgetCents < min) throw new BadRequestException(`Daily budget must be at least $${(min / 100).toFixed(2)} for ${channels.map((c) => CHANNEL_LABEL[c]).join(' + ')}`);
    if (g.dailyBudgetCents > MAX_DAILY_CENTS) throw new BadRequestException('Daily budget too high');
    const split = splitBudget(g.dailyBudgetCents, channels);
    for (const c of channels) if ((split[c] ?? 0) < CHANNEL_MIN_CENTS[c]) throw new BadRequestException(`${CHANNEL_LABEL[c]} needs at least $${(CHANNEL_MIN_CENTS[c] / 100).toFixed(2)}/day`);
    const need = Math.ceil(g.dailyBudgetCents * (1 + feePct('MANAGED') / 100));
    const { availableCents } = await this.fuel(organizationId);
    if (availableCents < need) throw new BadRequestException(`Add Ad Fuel first: launching needs one day of budget + ${feePct('MANAGED')}% fee ($${(need / 100).toFixed(2)}); you have $${(availableCents / 100).toFixed(2)}`);
    const claim = await prisma.boostGroup.updateMany({ where: { id: groupId, status: { in: ['DRAFT', 'FAILED'] } }, data: { status: 'LAUNCHING', launchRequestedAt: new Date(), lastError: null, split } });
    if (!claim.count) return this.groupView(groupId);
    const sp = await this.productFor(g.storeId, g.storeProductId);
    for (const c of channels) {
      const a = accts.find((x) => x.channel === c)!;
      const camp = await prisma.adCampaign.upsert({
        where: { storeId_requestId: { storeId: g.storeId, requestId: `${g.requestId}:${c}` } },
        create: { storeId: g.storeId, adAccountId: a.id, storeProductId: sp.id, channel: c, name: `${sp.title ?? sp.product.title} · Boost`, dailyBudgetCents: split[c], requestId: `${g.requestId}:${c}`, groupId, stage: 'DRAFT' },
        update: { dailyBudgetCents: split[c] },
      });
      if (!(await prisma.adCreative.count({ where: { campaignId: camp.id } }))) {
        await prisma.adCreative.create({ data: { campaignId: camp.id, headline: v.headline, body: v.body, assetUrl: (g.assets as any[])[0]?.url ?? null, assets: g.assets as any } });
      }
    }
    await this.recomputeCeilings(organizationId); // the platform can't spend before the ceiling exists
    this.bg(this.runLaunch(groupId));
    return this.groupView(groupId);
  }

  /** ads.launch worker body: feed → every channel in parallel → group LIVE. Re-runnable. */
  async runLaunch(groupId: string) {
    const g = await prisma.boostGroup.findUniqueOrThrow({ where: { id: groupId }, include: { store: true, campaigns: { include: { adAccount: true } } } });
    if (g.status !== 'LAUNCHING') return g.status;
    const sp = await this.productFor(g.storeId, g.storeProductId);
    const v = (g.variants as unknown as VariantP[])[g.variantIndex];
    const { origin, shopPath } = await DomainsService.storeUrls(g.store);
    const base = `${origin}${shopPath === '/' ? '' : shopPath}/p/${sp.id}`;
    const crops = g.assets as unknown as { ratio: string; url: string }[];
    await Promise.allSettled(g.campaigns.filter((c) => !c.launchedAt && c.stage === 'DRAFT').map(async (c) => {
      const ch = this.ch(c.channel);
      const acct = refOf(c.adAccount);
      if (c.channel !== 'META') {
        const feed = await ch.syncFeed(acct, [{ offerId: sp.id, title: sp.title ?? sp.product.title, description: sp.product.description, link: base, imageLink: crops.find((x) => x.ratio === '1:1')?.url ?? '', priceMinor: sp.priceCents, currency: 'USD', inStock: true, brand: g.store.name, category: sp.product.category, etaDaysMin: sp.product.etaDaysMin, etaDaysMax: sp.product.etaDaysMax, shippingMinor: sp.priceCents >= 5000 ? 0 : 499, country: 'US' }]).catch((e) => ({ error: String(e?.message ?? e) }));
        await prisma.adAccount.update({ where: { id: c.adAccountId }, data: { feedSyncedAt: new Date(), feedStatus: feed as any } });
      }
      const input: LaunchInput = {
        tag: `[sf:${c.id}]`, name: `${sp.title ?? sp.product.title} · Boost`, dailyBudgetMinor: c.dailyBudgetCents,
        finalUrl: `${base}?utm_source=${c.channel.toLowerCase()}&utm_medium=paid&utm_campaign=sf_${c.id}`, businessName: g.store.name,
        headlines: v.headlines, longHeadline: v.longHeadline, descriptions: v.descriptions, primaryText: v.body, images: crops, countries: ['US'], offerIds: [sp.id],
      };
      await this.launchCampaign(c.id, input);
    }));
    return this.finishLaunch(groupId);
  }

  private async launchCampaign(campaignId: string, input: LaunchInput) {
    const now = new Date();
    const lease = await prisma.adCampaign.updateMany({ where: { id: campaignId, launchedAt: null, stage: 'DRAFT', OR: [{ launchLockedUntil: null }, { launchLockedUntil: { lt: now } }] }, data: { launchLockedUntil: new Date(now.getTime() + LAUNCH_LEASE_MS) } });
    if (!lease.count) return 'busy';
    const c = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaignId }, include: { adAccount: true } });
    try {
      const res = await this.ch(c.channel).launch(refOf(c.adAccount), input, (c.externalRefs ?? {}) as Record<string, string>, async (refs) => { await prisma.adCampaign.update({ where: { id: campaignId }, data: { externalRefs: refs } }); });
      await prisma.adCampaign.update({ where: { id: campaignId }, data: { externalId: res.externalId, externalRefs: res.refs, stage: 'REVIEW', launchedAt: new Date(), launchLockedUntil: null, lastError: null } });
      return 'launched';
    } catch (e: any) {
      const pe = e instanceof PlatformError ? e : null;
      const msg = String(e?.message ?? e).slice(0, 500);
      if (pe && (pe.info.policy || !pe.isTransient)) {
        await prisma.adCampaign.update({ where: { id: campaignId }, data: { stage: 'REJECTED', pausedReason: pe.info.policy ? 'rejected' : 'error', lastError: msg, launchLockedUntil: null } });
        if (pe.info.policy && c.groupId) await this.policy.record(c.groupId, { result: 'block', rules: [`${c.channel.toLowerCase()}.rejected`], findings: [{ rule: `${c.channel.toLowerCase()}.rejected`, level: 'block', field: 'ad', message: msg }] }, c.channel.toLowerCase());
        return 'failed';
      }
      await prisma.adCampaign.update({ where: { id: campaignId }, data: { lastError: msg, launchLockedUntil: null } });
      return 'retry';
    }
  }

  private async finishLaunch(groupId: string) {
    const g = await prisma.boostGroup.findUniqueOrThrow({ where: { id: groupId }, include: { campaigns: true, store: true } });
    const pending = g.campaigns.filter((c) => c.stage === 'DRAFT');
    if (pending.length) return 'LAUNCHING'; // transient errors: the scheduler resumes (same refs, no duplicates)
    const ok = g.campaigns.filter((c) => c.launchedAt);
    if (!ok.length) {
      await prisma.boostGroup.update({ where: { id: groupId }, data: { status: 'FAILED', lastError: g.campaigns.map((c) => `${CHANNEL_LABEL[c.channel as Channel]}: ${c.lastError}`).join(' · ').slice(0, 1000) } });
      return 'FAILED';
    }
    await this.recomputeCeilings(g.store.organizationId); // ceilings match the live set before it's reported LIVE
    const launchedAt = new Date(Math.max(...ok.map((c) => c.launchedAt!.getTime())));
    const launchMs = launchedAt.getTime() - g.pickedAt.getTime();
    const r = await prisma.boostGroup.updateMany({ where: { id: groupId, status: 'LAUNCHING' }, data: { status: 'LIVE', launchedAt, launchMs } });
    if (r.count && launchMs > LAUNCH_TARGET_MS) this.logger.warn(`Boost ${groupId}: pick → launch took ${Math.round(launchMs / 1000)} s (target < 180 s)`);
    if (r.count) {
      await this.notifications.notify({ organizationId: g.store.organizationId, kind: 'boost_live', severity: 'info', title: 'Boost is live', body: `Your ad is live on ${ok.map((c) => CHANNEL_LABEL[c.channel as Channel]).join(', ')} and in review.`, dedupeKey: `boost_live:${groupId}` });
    }
    return 'LIVE';
  }
  /** Scheduler: groups stuck in LAUNCHING (transient failure, crash) → resume. */
  async resumeLaunches(now = new Date()) {
    const rows = await prisma.boostGroup.findMany({ where: { status: 'LAUNCHING', launchRequestedAt: { lt: new Date(now.getTime() - 30_000) } }, select: { id: true }, take: 20 });
    for (const r of rows) await this.runLaunch(r.id);
    return rows.map((r) => r.id);
  }

  // ------------------------------------------------------------------ pause / resume / budget
  private async setLive(c: AdCampaign & { adAccount: Acct }, on: boolean) {
    await this.ch(c.channel).setStatus(refOf(c.adAccount), c.externalId!, (c.externalRefs ?? {}) as Record<string, string>, on);
  }
  async pause(organizationId: string, groupId: string) {
    const g = await this.group(organizationId, groupId);
    for (const c of g.campaigns) {
      if (!c.externalId || !(LIVE as readonly string[]).includes(c.stage)) continue;
      await this.setLive(c, false);
      await prisma.adCampaign.updateMany({ where: { id: c.id, stage: { in: [...LIVE] } }, data: { stage: 'PAUSED', pausedReason: 'merchant' } });
    }
    await prisma.boostGroup.updateMany({ where: { id: groupId, status: 'LIVE' }, data: { status: 'PAUSED' } });
    await this.recomputeCeilings(organizationId);
    return this.groupView(groupId);
  }
  async resume(organizationId: string, groupId: string) {
    const g = await this.group(organizationId, groupId);
    const f = await this.fuel(organizationId);
    if (f.shortfallCents > 0 || f.availableCents <= 0) throw new BadRequestException('Add Ad Fuel to resume');
    await prisma.boostGroup.updateMany({ where: { id: groupId, status: 'PAUSED' }, data: { status: 'LIVE' } });
    await this.recomputeCeilings(organizationId);
    for (const c of g.campaigns) {
      if (c.stage !== 'PAUSED' || !c.externalId || !['merchant', 'low_fuel'].includes(c.pausedReason ?? '')) continue;
      await this.setLive(c, true);
      await prisma.adCampaign.updateMany({ where: { id: c.id, stage: 'PAUSED' }, data: { stage: (await this.learned(c.id)) ? 'STEADY' : (await prisma.adInsightDaily.count({ where: { campaignId: c.id } })) ? 'WARMING' : 'REVIEW', pausedReason: null } });
    }
    return this.groupView(groupId);
  }
  async setBudget(organizationId: string, groupId: string, total: number, manual = true) {
    const g = await this.group(organizationId, groupId);
    const channels = g.channels as Channel[];
    const min = minTotalFor(channels);
    if (!Number.isInteger(total) || total < min || total > MAX_DAILY_CENTS) throw new BadRequestException(`Daily budget must be between $${(min / 100).toFixed(2)} and $${MAX_DAILY_CENTS / 100}`);
    const split = splitBudget(total, channels);
    for (const c of g.campaigns) {
      if (c.externalId && c.stage !== 'REJECTED') await this.ch(c.channel).setBudget(refOf(c.adAccount), c.externalId, (c.externalRefs ?? {}) as Record<string, string>, split[c.channel] ?? c.dailyBudgetCents);
      await prisma.adCampaign.update({ where: { id: c.id }, data: { dailyBudgetCents: split[c.channel] ?? c.dailyBudgetCents } });
    }
    // Merchant lowers it by hand → stop auto-raising; raising by hand keeps the ladder on.
    await prisma.boostGroup.update({ where: { id: groupId }, data: { dailyBudgetCents: total, split, ...(manual && total < g.dailyBudgetCents ? { autoLadder: false } : {}) } });
    await this.recomputeCeilings(organizationId);
    return this.groupView(groupId);
  }
  async setAutoLadder(organizationId: string, groupId: string, on: boolean) {
    await this.group(organizationId, groupId);
    await prisma.boostGroup.update({ where: { id: groupId }, data: { autoLadder: on } });
    return this.groupView(groupId);
  }

  // ------------------------------------------------------------------ insights → charges
  private async learned(campaignId: string, now = new Date()) {
    const p = await prisma.adInsightDaily.aggregate({ where: { campaignId, date: { gte: new Date(now.getTime() - 7 * DAY) } }, _sum: { purchases: true } });
    return (p._sum.purchases ?? 0) >= STEADY_PURCHASES_7D;
  }
  /** Hourly: last 3 days of daily rows → AdInsightDaily → chargeDay(spend, 15% fee) (deltas). */
  async syncCampaign(campaignId: string, now = new Date(), lookbackDays = 3) {
    const c = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaignId }, include: { adAccount: true, store: true } });
    if (!c.externalId || !c.launchedAt || !c.groupId) return { skipped: true as const };
    const ch = this.ch(c.channel);
    const refs = (c.externalRefs ?? {}) as Record<string, string>;
    const since = new Date(Math.max(c.launchedAt.getTime() - DAY, now.getTime() - lookbackDays * DAY));
    const rows = await ch.insights(refOf(c.adAccount), c.externalId, refs, day(since), day(now));
    const status = await ch.status(refOf(c.adAccount), c.externalId, refs);
    const charges = [];
    for (const r of rows) {
      const date = new Date(`${r.date}T00:00:00Z`);
      const data = { impressions: r.impressions, clicks: r.clicks, spendCents: r.spendMinor, purchases: r.conversions, revenueCents: r.valueMinor, syncedAt: now };
      await prisma.adInsightDaily.upsert({ where: { campaignId_date: { campaignId, date } }, update: data, create: { campaignId, date, ...data } });
      charges.push({ date: r.date, ...(await this.wallet.chargeDay(campaignId, r.date, { spendCents: r.spendMinor, feeCents: feeFor(r.spendMinor, 'MANAGED') })) });
    }
    let stage = c.stage;
    if (status.review === 'DISAPPROVED' && c.stage !== 'REJECTED') stage = 'REJECTED';
    else if (c.stage === 'REVIEW' && status.review === 'APPROVED') stage = 'WARMING';
    else if (c.stage === 'WARMING' && (await this.learned(campaignId, now))) stage = 'STEADY';
    if (stage !== c.stage) {
      await prisma.adCampaign.update({ where: { id: campaignId }, data: { stage, ...(stage === 'REJECTED' ? { pausedReason: 'rejected', lastError: status.reason ?? `${CHANNEL_LABEL[c.channel as Channel]} did not approve this ad` } : {}) } });
      await prisma.adCreative.updateMany({ where: { campaignId }, data: { policyStatus: stage === 'REJECTED' ? 'rejected' : 'approved' } });
      if (stage === 'REJECTED') {
        await this.policy.record(c.groupId, { result: 'block', rules: [`${c.channel.toLowerCase()}.disapproved`], findings: [{ rule: `${c.channel.toLowerCase()}.disapproved`, level: 'block', field: 'ad', message: status.reason ?? 'Disapproved in review' }] }, c.channel.toLowerCase());
        await this.notifications.notify({ organizationId: c.store.organizationId, kind: 'boost_rejected', severity: 'warning', title: `${CHANNEL_LABEL[c.channel as Channel]} rejected an ad`, body: `${c.name} was not approved${status.reason ? `: ${status.reason}` : ''}. Other channels keep running.`, dedupeKey: `boost_rejected:${campaignId}` });
      }
    }
    await prisma.adCampaign.update({ where: { id: campaignId }, data: { lastSyncedAt: now } });
    return { rows: rows.length, charges, stage };
  }

  async syncAll(now = new Date(), minIntervalMs = 5 * 60_000, organizationId?: string) {
    const due = await prisma.adCampaign.findMany({
      where: { groupId: { not: null }, ...(organizationId ? { store: { organizationId } } : {}), externalId: { not: null }, launchedAt: { not: null }, stage: { notIn: ['DRAFT'] }, OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now.getTime() - minIntervalMs) } }] },
      select: { id: true, lastSyncedAt: true, groupId: true, store: { select: { organizationId: true } } }, take: 300,
    });
    const out: { id: string; result: string }[] = [];
    const orgs = new Set<string>();
    const groups = new Set<string>();
    for (const c of due) {
      const claim = await prisma.adCampaign.updateMany({ where: { id: c.id, lastSyncedAt: c.lastSyncedAt }, data: { lastSyncedAt: now } });
      if (!claim.count) continue;
      try {
        const r = await this.syncCampaign(c.id, now);
        out.push({ id: c.id, result: 'skipped' in r ? 'skipped' : `${r.rows} day(s), ${r.stage}` });
      } catch (e: any) {
        await prisma.adCampaign.update({ where: { id: c.id }, data: { lastError: String(e?.message ?? e).slice(0, 500) } });
        out.push({ id: c.id, result: `error: ${e?.message ?? e}` });
      }
      orgs.add(c.store.organizationId);
      if (c.groupId) groups.add(c.groupId);
    }
    for (const g of groups) await this.ladder(g).catch((e) => this.logger.warn(`ladder ${g}: ${e?.message ?? e}`));
    for (const o of orgs) { await this.recomputeCeilings(o); await this.runwayCheck(o, now); }
    return out;
  }

  // ------------------------------------------------------------------ float protection
  /** Lifetime ceiling for one account = platform spend so far + its share of collectible fuel. */
  async ceilingTarget(accountId: string) {
    const a = await prisma.adAccount.findUniqueOrThrow({ where: { id: accountId }, include: { store: true } });
    const org = a.store.organizationId;
    const { availableCents } = await this.fuel(org);
    const accts = await prisma.adAccount.findMany({ where: { mode: 'MANAGED', provisionStatus: 'ready', store: { organizationId: org } }, include: { campaigns: { where: { groupId: { not: null } }, select: { id: true, stage: true, dailyBudgetCents: true } } } });
    const k = 1 + feePct('MANAGED') / 100;
    let uncharged = 0;
    let weightAll = 0;
    let weightMe = 0;
    let spentMe = 0;
    for (const x of accts) {
      const spent = await this.ch(x.channel).accountSpend(refOf(x));
      const ids = x.campaigns.map((c) => c.id);
      const charged = ids.length ? (await prisma.adChargeDay.aggregate({ where: { campaignId: { in: ids } }, _sum: { spendOwedCents: true } }))._sum.spendOwedCents ?? 0 : 0;
      uncharged += Math.max(0, spent - charged);
      // DRAFT here = being launched (campaign rows only exist once a group launches): sized before it can deliver
      const w = x.campaigns.filter((c) => c.stage === 'DRAFT' || (LIVE as readonly string[]).includes(c.stage)).reduce((n, c) => n + c.dailyBudgetCents, 0);
      weightAll += w;
      if (x.id === accountId) { weightMe = w; spentMe = spent; }
    }
    const allowance = Math.max(0, Math.floor((availableCents - Math.ceil(uncharged * k)) / k));
    const share = weightAll > 0 ? Math.floor((allowance * weightMe) / weightAll) : 0;
    return { capMinor: spentMe + share, spent: spentMe, allowance, share };
  }
  /** Under a lease; triggers while it runs set capDirty and are picked up by the loop. */
  async applyCeiling(accountId: string, now = new Date()) {
    const lease = await prisma.adAccount.updateMany({ where: { id: accountId, OR: [{ capLockedUntil: null }, { capLockedUntil: { lt: now } }] }, data: { capLockedUntil: new Date(now.getTime() + CAP_LEASE_MS) } });
    if (!lease.count) return null;
    let last: { capMinor: number; applied: number } | null = null;
    try {
      for (let i = 0; i < 5; i++) {
        const d = await prisma.adAccount.updateMany({ where: { id: accountId, capDirty: true }, data: { capDirty: false } });
        if (!d.count) break;
        const t = await this.ceilingTarget(accountId);
        const a = await prisma.adAccount.findUniqueOrThrow({ where: { id: accountId } });
        const r = await this.ch(a.channel).applyCeiling(refOf(a), t.capMinor);
        await prisma.adAccount.update({ where: { id: accountId }, data: { capMinor: r.appliedMinor, capAppliedAt: new Date(), lifetimeSpendCents: t.spent } });
        last = { capMinor: t.capMinor, applied: r.appliedMinor };
      }
    } catch (e: any) {
      await prisma.adAccount.update({ where: { id: accountId }, data: { capDirty: true, lastError: `ceiling: ${String(e?.message ?? e).slice(0, 400)}` } });
      this.logger.warn(`ceiling ${accountId}: ${e?.message ?? e}`);
    } finally {
      await prisma.adAccount.update({ where: { id: accountId }, data: { capLockedUntil: null } });
    }
    return last;
  }
  async recomputeCeilings(organizationId: string) {
    const where = { mode: 'MANAGED' as const, provisionStatus: 'ready', store: { organizationId } };
    // One row per statement, in id order: a multi-row UPDATE behind a relation filter takes row locks in
    // no fixed order and deadlocks against a concurrent recompute (found by the concurrency test).
    const accts = await prisma.adAccount.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } });
    for (const a of accts) await prisma.adAccount.update({ where: { id: a.id }, data: { capDirty: true } });
    for (const a of accts) await this.applyCeiling(a.id);
  }

  // ------------------------------------------------------------------ fuel
  async onFuelEmpty(walletId: string) {
    const w = await prisma.adWallet.findUniqueOrThrow({ where: { id: walletId } });
    const live = await prisma.adCampaign.findMany({ where: { groupId: { not: null }, store: { organizationId: w.organizationId }, stage: { in: [...LIVE] } }, include: { adAccount: true } });
    let paused = 0;
    await Promise.all(live.map(async (c) => {
      await this.setLive(c, false).catch((e) => this.logger.warn(`low-fuel pause ${c.channel} ${c.id}: ${e?.message ?? e}`));
      const n = (await prisma.adCampaign.updateMany({ where: { id: c.id, stage: { in: [...LIVE] } }, data: { stage: 'PAUSED', pausedReason: 'low_fuel' } })).count;
      paused += n; // read after the await (no lost update across the parallel pauses)
    }));
    await this.boost.onFuelEmpty(walletId, paused); // OWNED campaigns + the one notice
    await this.recomputeCeilings(w.organizationId);
    return { paused };
  }
  async onFuelAdded(walletId: string) {
    await this.boost.onFuelAdded(walletId); // settles shortfalls; resumes OWNED low-fuel pauses
    const w = await prisma.adWallet.findUniqueOrThrow({ where: { id: walletId } });
    const f = await this.fuel(w.organizationId);
    if (f.shortfallCents > 0 || f.availableCents <= 0) return { resumed: 0 };
    await this.recomputeCeilings(w.organizationId); // ceilings first, then turn delivery back on
    const paused = await prisma.adCampaign.findMany({ where: { groupId: { not: null }, store: { organizationId: w.organizationId }, stage: 'PAUSED', pausedReason: 'low_fuel', group: { status: 'LIVE' } }, include: { adAccount: true } });
    let resumed = 0;
    for (const c of paused) {
      try {
        await this.setLive(c, true);
        resumed += (await prisma.adCampaign.updateMany({ where: { id: c.id, stage: 'PAUSED', pausedReason: 'low_fuel' }, data: { stage: (await this.learned(c.id)) ? 'STEADY' : 'WARMING', pausedReason: null } })).count;
      } catch (e: any) {
        this.logger.warn(`resume ${c.id}: ${e?.message ?? e}`);
      }
    }
    return { resumed };
  }
  /** Less than one day of runway at current managed budgets → heads-up (once a day). */
  async runwayCheck(organizationId: string, now = new Date()) {
    const live = await prisma.adCampaign.aggregate({ where: { groupId: { not: null }, store: { organizationId }, stage: { in: [...LIVE] } }, _sum: { dailyBudgetCents: true } });
    const perDay = Math.ceil((live._sum.dailyBudgetCents ?? 0) * (1 + feePct('MANAGED') / 100));
    if (!perDay) return null;
    const f = await this.fuel(organizationId);
    if (f.availableCents >= perDay) return null;
    return this.notifications.notify({
      organizationId, kind: 'fuel_low', severity: 'warning', title: 'Less than a day of Ad Fuel left',
      body: `Boost spends about $${(perDay / 100).toFixed(2)}/day (incl. ${feePct('MANAGED')}% fee); you have $${(f.availableCents / 100).toFixed(2)}. Top up or turn on auto-reload so ads don't pause.`,
      dedupeKey: `fuel_low:${f.wallet.id}:${day(now)}`,
    });
  }

  // ------------------------------------------------------------------ ladder
  async ladder(groupId: string) {
    const g = await prisma.boostGroup.findUniqueOrThrow({ where: { id: groupId }, include: { campaigns: { select: { id: true } }, store: true } });
    if (!g.autoLadder || g.status !== 'LIVE') return null;
    const s = await prisma.adInsightDaily.aggregate({ where: { campaignId: { in: g.campaigns.map((c) => c.id) } }, _sum: { spendCents: true } });
    const spent = s._sum.spendCents ?? 0;
    const step = LADDER.filter((l) => spent >= l.atSpendCents).length;
    if (step <= g.ladderStep) return null;
    const claim = await prisma.boostGroup.updateMany({ where: { id: groupId, ladderStep: g.ladderStep, autoLadder: true }, data: { ladderStep: step } });
    if (!claim.count) return null;
    const target = LADDER[step - 1].dailyCents;
    if (target > g.dailyBudgetCents && target >= minTotalFor(g.channels as Channel[])) {
      await this.setBudget(g.store.organizationId, groupId, target, false);
      await this.notifications.notify({ organizationId: g.store.organizationId, kind: 'boost_ladder', severity: 'info', title: 'Boost budget stepped up', body: `After $${(LADDER[step - 1].atSpendCents / 100).toFixed(0)} of spend, the daily budget is now $${(target / 100).toFixed(2)}. Lower it any time; that turns automatic steps off.`, dedupeKey: `ladder:${groupId}:${step}` });
    }
    return { step, target };
  }

  // ------------------------------------------------------------------ reconcile
  async reconcile(now = new Date(), organizationId?: string) {
    const until = day(new Date(now.getTime() - DAY));
    const since = day(new Date(now.getTime() - RECONCILE_DAYS * DAY));
    const camps = await prisma.adCampaign.findMany({ where: { groupId: { not: null }, externalId: { not: null }, launchedAt: { not: null }, ...(organizationId ? { store: { organizationId } } : {}) }, include: { adAccount: true, store: true } });
    const out: { campaignId: string; date: string; platform: number; charged: number; driftBps: number; status: string }[] = [];
    for (const c of camps) {
      let rows;
      try { rows = await this.ch(c.channel).insights(refOf(c.adAccount), c.externalId!, (c.externalRefs ?? {}) as Record<string, string>, since, until); } catch (e: any) { this.logger.warn(`reconcile ${c.id}: ${e?.message ?? e}`); continue; }
      const platform = new Map(rows.map((r) => [r.date, r]));
      const charges = await prisma.adChargeDay.findMany({ where: { campaignId: c.id, date: { gte: new Date(`${since}T00:00:00Z`), lte: new Date(`${until}T00:00:00Z`) } } });
      const byDate = new Map(charges.map((x) => [day(x.date), x]));
      for (const date of new Set([...platform.keys(), ...byDate.keys()])) {
        if (date < since || date > until) continue;
        const p = platform.get(date)?.spendMinor ?? 0;
        const charged = byDate.get(date)?.spendOwedCents ?? 0;
        const driftBps = p === charged ? 0 : Math.round((Math.abs(p - charged) / Math.max(p, charged, 1)) * 10_000);
        let adjustedCents = 0;
        let status = 'ok';
        if (driftBps > 0) {
          const r = await this.wallet.chargeDay(c.id, date, { spendCents: p, feeCents: feeFor(p, 'MANAGED') });
          adjustedCents = r.chargedNowCents;
          const row = platform.get(date);
          if (row) await prisma.adInsightDaily.upsert({ where: { campaignId_date: { campaignId: c.id, date: new Date(`${date}T00:00:00Z`) } }, update: { spendCents: p, impressions: row.impressions, clicks: row.clicks, purchases: row.conversions, revenueCents: row.valueMinor }, create: { campaignId: c.id, date: new Date(`${date}T00:00:00Z`), spendCents: p, impressions: row.impressions, clicks: row.clicks, purchases: row.conversions, revenueCents: row.valueMinor } });
          status = driftBps > RECONCILE_ALERT_BPS() ? 'alert' : 'adjusted';
          if (status === 'alert') {
            const body = `${CHANNEL_LABEL[c.channel as Channel]} reported $${(p / 100).toFixed(2)} for ${date}; we had charged $${(charged / 100).toFixed(2)} (${(driftBps / 100).toFixed(1)}% drift). Fuel was ${adjustedCents >= 0 ? 'charged' : 'credited'} $${(Math.abs(adjustedCents) / 100).toFixed(2)} to match.`;
            await this.notifications.notify({ organizationId: c.store.organizationId, kind: 'ads_reconcile', severity: 'info', title: 'Ad spend corrected', body, dedupeKey: `reconcile:${c.id}:${date}:${p}` });
            await this.notifications.notify({ organizationId: null, kind: 'ads_reconcile_drift', severity: 'warning', title: `Spend drift ${(driftBps / 100).toFixed(1)}% on ${c.channel}`, body: `${body} (campaign ${c.id})`, dedupeKey: `ops-reconcile:${c.id}:${date}:${p}` });
          }
        }
        await prisma.adReconcile.upsert({ where: { campaignId_date: { campaignId: c.id, date: new Date(`${date}T00:00:00Z`) } }, update: { platformSpendCents: p, chargedSpendCents: charged, driftBps, adjustedCents, status }, create: { campaignId: c.id, date: new Date(`${date}T00:00:00Z`), platformSpendCents: p, chargedSpendCents: charged, driftBps, adjustedCents, status } });
        out.push({ campaignId: c.id, date, platform: p, charged, driftBps, status });
      }
    }
    // Account level: spend the platform billed us that no campaign of ours explains
    const accts = await prisma.adAccount.findMany({ where: { mode: 'MANAGED', provisionStatus: 'ready', ...(organizationId ? { store: { organizationId } } : {}) }, include: { campaigns: { select: { id: true } } } });
    for (const a of accts) {
      if (!a.campaigns.length) continue;
      const billed = await this.ch(a.channel).accountSpend(refOf(a)).catch(() => null);
      if (billed === null) continue;
      const ours = (await prisma.adInsightDaily.aggregate({ where: { campaignId: { in: a.campaigns.map((c) => c.id) } }, _sum: { spendCents: true } }))._sum.spendCents ?? 0;
      if (billed - ours > Math.max(100, billed / 100)) {
        await this.notifications.notify({ organizationId: null, kind: 'ads_unknown_spend', severity: 'critical', title: `Unexplained spend on ${a.channel} account ${a.externalId}`, body: `Platform billed $${(billed / 100).toFixed(2)}, campaigns explain $${(ours / 100).toFixed(2)}.`, dedupeKey: `unknown-spend:${a.id}:${billed}` });
      }
      await prisma.adAccount.update({ where: { id: a.id }, data: { lifetimeSpendCents: billed } });
    }
    return out;
  }

  // ------------------------------------------------------------------ views
  private totals(c: AdCampaign & { insights: { spendCents: number; purchases: number; revenueCents: number; clicks: number; impressions: number }[]; charges: { spendDebitedCents: number; feeDebitedCents: number; feeOwedCents: number; spendOwedCents: number }[] }) {
    const spend = c.insights.reduce((n, d) => n + d.spendCents, 0);
    const purchases = c.insights.reduce((n, d) => n + d.purchases, 0);
    const revenue = c.insights.reduce((n, d) => n + d.revenueCents, 0);
    const fee = c.charges.reduce((n, d) => n + d.feeOwedCents, 0);
    return { spendCents: spend, feeCents: fee, purchases, revenueCents: revenue, clicks: c.insights.reduce((n, d) => n + d.clicks, 0), impressions: c.insights.reduce((n, d) => n + d.impressions, 0), roas: spend ? Math.round((revenue / spend) * 100) / 100 : null, cpaCents: purchases ? Math.round((spend + fee) / purchases) : null };
  }
  async groupView(groupId: string) {
    const g = await prisma.boostGroup.findUniqueOrThrow({
      where: { id: groupId },
      include: { store: true, policy: { orderBy: { createdAt: 'desc' }, take: 10 }, campaigns: { include: { insights: { orderBy: { date: 'desc' }, take: 30 }, charges: true, reconciles: { orderBy: { date: 'desc' }, take: 7 }, adAccount: { select: { channel: true, externalId: true, capMinor: true } } }, orderBy: { channel: 'asc' } } },
    });
    const sp = await prisma.storeProduct.findUnique({ where: { id: g.storeProductId }, include: { product: true } });
    const campaigns = g.campaigns.map((c) => ({ id: c.id, channel: c.channel, label: CHANNEL_LABEL[c.channel as Channel], name: c.name, stage: c.stage, pausedReason: c.pausedReason, lastError: c.lastError, externalId: c.externalId, dailyBudgetCents: c.dailyBudgetCents, launchedAt: c.launchedAt, lastSyncedAt: c.lastSyncedAt, ceilingCents: c.adAccount.capMinor, totals: this.totals(c), days: c.insights.map((d) => ({ date: day(d.date), spendCents: d.spendCents, purchases: d.purchases, revenueCents: d.revenueCents })), reconcile: c.reconciles.map((r) => ({ date: day(r.date), platformSpendCents: r.platformSpendCents, chargedSpendCents: r.chargedSpendCents, driftBps: r.driftBps, status: r.status })) }));
    const t = campaigns.reduce((a, c) => ({ spend: a.spend + c.totals.spendCents, fee: a.fee + c.totals.feeCents, purchases: a.purchases + c.totals.purchases, revenue: a.revenue + c.totals.revenueCents }), { spend: 0, fee: 0, purchases: 0, revenue: 0 });
    // True profit (blueprint): revenue − product cost − shipping − ad spend − fee. Revenue/purchases are platform-attributed.
    const cogs = (sp?.product.costCents ?? 0) * t.purchases;
    const shipping = (sp && sp.priceCents >= 5000 ? 0 : 499) * t.purchases;
    return {
      id: g.id, status: g.status, storeId: g.storeId, storeProductId: g.storeProductId, product: sp ? { title: sp.title ?? sp.product.title, priceCents: sp.priceCents, costCents: sp.product.costCents, imageUrl: sp.product.imageUrl, etaDaysMin: sp.product.etaDaysMin, etaDaysMax: sp.product.etaDaysMax } : null,
      channels: g.channels, dailyBudgetCents: g.dailyBudgetCents, split: g.split, variants: g.variants, variantIndex: g.variantIndex, assets: g.assets, policyResult: g.policyResult, policy: g.policy,
      autoLadder: g.autoLadder, ladderStep: g.ladderStep, ladder: LADDER, pickedAt: g.pickedAt, launchRequestedAt: g.launchRequestedAt, launchedAt: g.launchedAt, launchMs: g.launchMs, launchSystemMs: g.launchedAt && g.launchRequestedAt ? g.launchedAt.getTime() - g.launchRequestedAt.getTime() : null, launchTargetMs: LAUNCH_TARGET_MS, lastError: g.lastError,
      feePct: feePct('MANAGED'), minDailyCents: minTotalFor(g.channels as Channel[]),
      totals: { spendCents: t.spend, feeCents: t.fee, purchases: t.purchases, revenueCents: t.revenue, roas: t.spend ? Math.round((t.revenue / t.spend) * 100) / 100 : null, cpaCents: t.purchases ? Math.round((t.spend + t.fee) / t.purchases) : null, cogsCents: cogs, shippingCents: shipping, trueProfitCents: t.revenue - cogs - shipping - t.spend - t.fee },
      campaigns,
    };
  }
  async overview(organizationId: string, storeId: string) {
    await this.store(organizationId, storeId);
    const accts = await prisma.adAccount.findMany({ where: { storeId, mode: 'MANAGED' } });
    const groups = await prisma.boostGroup.findMany({ where: { storeId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true } });
    const f = await this.fuel(organizationId);
    const allowed = enabledChannels();
    return {
      feePct: feePct('MANAGED'), fuel: { availableCents: f.availableCents, shortfallCents: f.shortfallCents },
      channels: CHANNELS.filter((c) => allowed.includes(c)).map((c) => {
        const a = accts.find((x) => x.channel === c);
        const ad = this.ch(c);
        return { channel: c, label: CHANNEL_LABEL[c], mode: ad.mode, minDailyCents: CHANNEL_MIN_CENTS[c], account: a ? { id: a.id, status: a.provisionStatus, externalId: a.externalId.startsWith('pending:') ? null : a.externalId, lastError: a.lastError, capMinor: a.capMinor, lifetimeSpendCents: a.lifetimeSpendCents, feedStatus: a.feedStatus, capAppliedAt: a.capAppliedAt } : null };
      }),
      groups: await Promise.all(groups.map((g) => this.groupView(g.id))),
    };
  }
  /** Stub-only test-events view across channels for this store's managed accounts */
  async testEvents(organizationId: string, storeId: string) {
    await this.store(organizationId, storeId);
    const accts = await prisma.adAccount.findMany({ where: { storeId, mode: 'MANAGED', provisionStatus: 'ready' } });
    return accts.map((a) => ({ channel: a.channel, events: this.ch(a.channel).testEvents?.(refOf(a)) ?? [] }));
  }
}
