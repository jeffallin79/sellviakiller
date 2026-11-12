import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { prisma, Prisma, type AdAccount, type AdCampaign, type AdConnection } from '@storeforge/db';
import { getMetaClient, MetaApiError, purchasesOf, toMinor, META_SCOPES, type MetaStatus } from './meta';
import { sealToken, openToken } from './token-vault';
import { AdWalletService } from './wallet.service';
import { fuelEvents } from './fuel-events';
import { NotificationsService } from '../payments/notifications.service';
import { DomainsService } from '../domains/domains.service';
import { adminUrl, feeFor, feePct, MAX_DAILY_CENTS, metaRedirectUri, minDailyCents, STEADY_PURCHASES_7D, usesFuel } from './ads.config';

const OAUTH_STATE_TTL_MS = 10 * 60_000;
const LAUNCH_LEASE_MS = 2 * 60_000;
const REQUIRED_SCOPES = ['ads_management', 'ads_read'];
const LIVE_STAGES = ['REVIEW', 'WARMING', 'STEADY'] as const;
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Boost, "connect your own" Meta ad account (blueprint slice 3).
 *
 *   connect  → OAuthState (single use, 10 min) → Facebook Login → callback exchanges the code for a
 *              long-lived token, sealed with AES-256-GCM (ADS_TOKEN_KEY) on AdConnection
 *   select   → merchant picks ad account + Page + Pixel → AdAccount(mode OWNED)
 *   launch   → campaign → ad set → creative → ad, each Meta id saved as soon as it exists, so a
 *              retried launch resumes instead of duplicating; a create that timed out is found again
 *              by the "[sf:<id>]" tag in its name. A short lease stops two launches running at once.
 *   sync     → insights per day → AdInsightDaily → AdWalletService.chargeDay (deltas; never < 0)
 *   fuel     → 'empty' pauses fuel-funded campaigns (low_fuel); 'added' settles shortfalls and resumes
 */
@Injectable()
export class BoostService {
  private readonly logger = new Logger(BoostService.name);
  private readonly notifications = new NotificationsService();
  constructor(private readonly wallet: AdWalletService = new AdWalletService()) {}

  /** Wire the in-process fuel signals (called by AdsModule; tests call the handlers directly). */
  listen() {
    fuelEvents.on('empty', (walletId: string) => void this.onFuelEmpty(walletId).catch((e) => this.logger.warn(`low-fuel: ${e?.message ?? e}`)));
    fuelEvents.on('added', (walletId: string) => void this.onFuelAdded(walletId).catch((e) => this.logger.warn(`fuel-added: ${e?.message ?? e}`)));
  }

  private meta() {
    return getMetaClient();
  }
  private async store(organizationId: string, storeId: string) {
    const s = await prisma.store.findFirst({ where: { id: storeId, organizationId, deletedAt: null } });
    if (!s) throw new NotFoundException('Store not found');
    return s;
  }

  // ---------------------------------------------------------------- connect
  async startConnect(organizationId: string, userId: string, storeId: string) {
    await this.store(organizationId, storeId);
    const state = randomBytes(24).toString('base64url');
    await prisma.oAuthState.create({ data: { id: state, channel: 'META', storeId, userId, expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS) } });
    return { url: this.meta().authorizeUrl({ state, redirectUri: metaRedirectUri() }), mode: this.meta().mode };
  }

  /** Facebook redirects here. Returns the admin URL to send the merchant back to. Never throws. */
  async callback(q: { code?: string; state?: string; error?: string; error_description?: string }): Promise<string> {
    const back = (params: Record<string, string>) => `${adminUrl()}/boost?${new URLSearchParams(params)}`;
    if (!q.state) return back({ error: 'missing_state' });
    // Single use: the conditional update is the lock (a replayed or raced callback gets count 0).
    const used = await prisma.oAuthState.updateMany({ where: { id: q.state, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    const st = await prisma.oAuthState.findUnique({ where: { id: q.state } });
    if (used.count !== 1 || !st) return back({ error: 'expired_state' });
    if (q.error || !q.code) return back({ store: st.storeId, error: q.error ?? 'cancelled' });
    try {
      const meta = this.meta();
      const t = await meta.exchangeCode({ code: q.code, redirectUri: metaRedirectUri() });
      const me = await meta.me(t.accessToken);
      const missing = REQUIRED_SCOPES.filter((s) => !t.scopes.includes(s));
      const data = {
        externalUserId: me.id, externalName: me.name, tokenCipher: sealToken(t.accessToken), tokenExpiresAt: t.expiresAt, scopes: t.scopes,
        status: missing.length ? 'missing_scopes' : 'active', lastError: missing.length ? `Missing permissions: ${missing.join(', ')}` : null,
      };
      await prisma.adConnection.upsert({ where: { storeId_channel: { storeId: st.storeId, channel: 'META' } }, update: data, create: { storeId: st.storeId, channel: 'META', ...data } });
      return back(missing.length ? { store: st.storeId, error: 'missing_scopes' } : { store: st.storeId, connected: '1' });
    } catch (e: any) {
      this.logger.warn(`meta callback: ${e?.message ?? e}`);
      return back({ store: st.storeId, error: 'exchange_failed' });
    }
  }

  private async connection(storeId: string) {
    return prisma.adConnection.findUnique({ where: { storeId_channel: { storeId, channel: 'META' } } });
  }
  /** Runs a Meta call with the store's token; auth errors mark the connection expired (merchant must reconnect). */
  private async withToken<T>(conn: AdConnection, fn: (token: string) => Promise<T>): Promise<T> {
    if (conn.status !== 'active') throw new ConflictException('Reconnect your Meta account to continue');
    try {
      return await fn(openToken(conn.tokenCipher));
    } catch (e) {
      if (e instanceof MetaApiError && e.isAuth) {
        await prisma.adConnection.update({ where: { id: conn.id }, data: { status: 'expired', lastError: e.message.slice(0, 500) } });
        const store = await prisma.store.findUnique({ where: { id: conn.storeId } });
        if (store) {
          await this.notifications.notify({
            organizationId: store.organizationId, kind: 'boost_reconnect', severity: 'warning',
            title: 'Reconnect Meta to keep Boost running', body: `Meta stopped accepting StoreForge's access for ${store.name} (${e.message}). Open Boost and press Reconnect.`,
            dedupeKey: `boost_reconnect:${conn.id}:${conn.updatedAt.getTime()}`,
          });
        }
      }
      throw e;
    }
  }
  private metaError(e: unknown): never {
    if (e instanceof MetaApiError) throw new BadRequestException(`Meta: ${e.message}`);
    throw e;
  }

  /** Everything the Boost screen needs for one store. */
  async overview(organizationId: string, storeId: string) {
    await this.store(organizationId, storeId);
    const conn = await this.connection(storeId);
    const account = await prisma.adAccount.findUnique({ where: { storeId_channel_mode: { storeId, channel: 'META', mode: 'OWNED' } } });
    const campaigns = await this.campaigns(organizationId, storeId);
    return {
      mode: this.meta().mode,
      feePct: feePct('OWNED'),
      managedFeePct: feePct('MANAGED'),
      minDailyCents: minDailyCents(),
      usesFuel: usesFuel('OWNED'),
      requiredScopes: META_SCOPES,
      connection: conn ? { status: conn.status, name: conn.externalName, scopes: conn.scopes, expiresAt: conn.tokenExpiresAt, lastError: conn.lastError, connectedAt: conn.createdAt } : null,
      account: account && account.status !== 'disconnected' ? account : null,
      campaigns,
    };
  }

  /** Ad accounts, Pages and (per account) Pixels the token can see. */
  async options(organizationId: string, storeId: string, adAccountId?: string) {
    await this.store(organizationId, storeId);
    const conn = await this.connection(storeId);
    if (!conn) throw new ConflictException('Connect Meta first');
    return this.withToken(conn, async (t) => {
      const [accounts, pages] = await Promise.all([this.meta().listAdAccounts(t), this.meta().listPages(t)]);
      const pick = adAccountId ?? accounts.find((a) => a.accountStatus === 1)?.id;
      const pixels = pick ? await this.meta().listPixels(t, pick) : [];
      return { accounts, pages, pixels, adAccountId: pick ?? null };
    }).catch((e) => this.metaError(e));
  }

  async selectAccount(organizationId: string, storeId: string, sel: { adAccountId: string; pageId: string; pixelId: string; testEventCode?: string | null }) {
    await this.store(organizationId, storeId);
    const conn = await this.connection(storeId);
    if (!conn) throw new ConflictException('Connect Meta first');
    const o = await this.options(organizationId, storeId, sel.adAccountId);
    const acct = o.accounts.find((a) => a.id === sel.adAccountId);
    if (!acct) throw new BadRequestException('That ad account is not available to this login');
    if (acct.accountStatus !== 1) throw new BadRequestException(`${acct.name} is not active on Meta (status ${acct.accountStatus}). Fix it in Meta Business Settings or pick another account.`);
    const page = o.pages.find((p) => p.id === sel.pageId);
    if (!page) throw new BadRequestException('Pick a Facebook Page you manage');
    const pixel = o.pixels.find((p) => p.id === sel.pixelId);
    if (!pixel) throw new BadRequestException('Pick a Pixel (dataset) from this ad account');
    const existing = await prisma.adAccount.findUnique({ where: { storeId_channel_mode: { storeId, channel: 'META', mode: 'OWNED' } } });
    if (existing && existing.externalId !== acct.id && (await prisma.adCampaign.count({ where: { adAccountId: existing.id, stage: { in: [...LIVE_STAGES] } } }))) {
      throw new ConflictException('Pause the running campaigns before switching ad accounts');
    }
    const data = {
      externalId: acct.id, name: acct.name, currency: acct.currency, timezone: acct.timezone, status: 'active', tokenRef: conn.id,
      pageId: page.id, pageName: page.name, pixelId: pixel.id, pixelName: pixel.name, testEventCode: sel.testEventCode?.trim() || null,
    };
    return prisma.adAccount.upsert({
      where: { storeId_channel_mode: { storeId, channel: 'META', mode: 'OWNED' } },
      update: data,
      create: { storeId, channel: 'META', mode: 'OWNED', ...data },
    });
  }

  async setTestEventCode(organizationId: string, storeId: string, code: string | null) {
    await this.store(organizationId, storeId);
    const a = await prisma.adAccount.findUnique({ where: { storeId_channel_mode: { storeId, channel: 'META', mode: 'OWNED' } } });
    if (!a) throw new NotFoundException('No ad account selected');
    return prisma.adAccount.update({ where: { id: a.id }, data: { testEventCode: code?.trim() || null } });
  }

  /** Pauses everything on Meta (best effort), forgets the token. */
  async disconnect(organizationId: string, storeId: string) {
    await this.store(organizationId, storeId);
    const conn = await this.connection(storeId);
    const live = await prisma.adCampaign.findMany({ where: { storeId, channel: 'META', stage: { in: [...LIVE_STAGES] } } });
    for (const c of live) {
      if (conn && c.externalId) await this.withToken(conn, (t) => this.meta().setStatus(t, c.externalId!, 'PAUSED')).catch(() => null);
      await prisma.adCampaign.update({ where: { id: c.id }, data: { stage: 'PAUSED', pausedReason: 'disconnected' } });
    }
    await prisma.adAccount.updateMany({ where: { storeId, channel: 'META', mode: 'OWNED' }, data: { status: 'disconnected', tokenRef: null } });
    if (conn) await prisma.adConnection.delete({ where: { id: conn.id } });
    return { paused: live.length };
  }

  // ---------------------------------------------------------------- campaigns
  async campaigns(organizationId: string, storeId: string) {
    const rows = await prisma.adCampaign.findMany({
      where: { storeId, store: { organizationId } },
      orderBy: { createdAt: 'desc' },
      include: { creatives: true, insights: { orderBy: { date: 'desc' }, take: 30 }, charges: true },
    });
    return rows.map(({ insights, charges, ...c }) => {
      const sum = (k: 'impressions' | 'clicks' | 'spendCents' | 'purchases' | 'revenueCents') => insights.reduce((a, r) => a + r[k], 0);
      const spend = sum('spendCents');
      return {
        ...c,
        totals: {
          impressions: sum('impressions'), clicks: sum('clicks'), spendCents: spend, purchases: sum('purchases'), revenueCents: sum('revenueCents'),
          roas: spend ? Math.round((sum('revenueCents') / spend) * 100) / 100 : null,
          fuelChargedCents: charges.reduce((a, r) => a + r.spendDebitedCents + r.feeDebitedCents, 0),
          shortfallCents: charges.reduce((a, r) => a + r.shortfallCents, 0),
        },
        days: insights.map((r) => ({ date: day(r.date), impressions: r.impressions, clicks: r.clicks, spendCents: r.spendCents, purchases: r.purchases, revenueCents: r.revenueCents })),
      };
    });
  }

  async createCampaign(
    organizationId: string,
    input: { storeId: string; storeProductId: string; dailyBudgetCents: number; requestId: string; headline?: string; body?: string; countries?: string[] },
  ) {
    const store = await this.store(organizationId, input.storeId);
    const existing = await prisma.adCampaign.findUnique({ where: { storeId_requestId: { storeId: store.id, requestId: input.requestId } } });
    if (existing) return this.launch(existing.id); // idempotent retry (resumes a half-finished launch)

    const account = await prisma.adAccount.findUnique({ where: { storeId_channel_mode: { storeId: store.id, channel: 'META', mode: 'OWNED' } } });
    if (!account || account.status !== 'active' || !account.pixelId || !account.pageId) throw new ConflictException('Connect Meta and pick an ad account, Page and Pixel first');
    if (!Number.isInteger(input.dailyBudgetCents) || input.dailyBudgetCents < minDailyCents() || input.dailyBudgetCents > MAX_DAILY_CENTS) {
      throw new BadRequestException(`Daily budget must be between $${minDailyCents() / 100} and $${MAX_DAILY_CENTS / 100}`);
    }
    await this.requireFuel(organizationId, account);
    const sp = await prisma.storeProduct.findFirst({ where: { id: input.storeProductId, storeId: store.id, active: true, deletedAt: null }, include: { product: true } });
    if (!sp) throw new BadRequestException('Pick an active product from this shop');
    const title = sp.title ?? sp.product.title;
    let row: AdCampaign;
    try {
      row = await prisma.$transaction(async (tx) => {
        const c = await tx.adCampaign.create({
          data: { storeId: store.id, adAccountId: account.id, storeProductId: sp.id, channel: 'META', name: title.slice(0, 80), dailyBudgetCents: input.dailyBudgetCents, requestId: input.requestId },
        });
        await tx.adCreative.create({
          data: {
            campaignId: c.id, type: 'image', assetUrl: sp.product.imageUrl,
            headline: (input.headline?.trim() || title).slice(0, 40),
            body: (input.body?.trim() || `${title}. Ships in ${sp.product.etaDaysMin}–${sp.product.etaDaysMax} days, tracked all the way.`).slice(0, 125),
          },
        });
        // The tag makes a timed-out create findable on Meta (no duplicate campaigns on retry).
        return tx.adCampaign.update({ where: { id: c.id }, data: { name: `${title.slice(0, 60)} · Boost [sf:${c.id}]` } });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await prisma.adCampaign.findUniqueOrThrow({ where: { storeId_requestId: { storeId: store.id, requestId: input.requestId } } });
        return this.launch(again.id);
      }
      throw e;
    }
    return this.launch(row.id, input.countries);
  }

  private async requireFuel(organizationId: string, account: Pick<AdAccount, 'mode'>) {
    if (!usesFuel(account.mode)) return;
    const w = await this.wallet.walletFor(organizationId);
    if (w.balanceCents + w.bonusCents <= 0) throw new ConflictException('Add Ad Fuel first: Boost pauses when fuel is empty');
  }

  /** Resumable, single-flight launch (DRAFT → REVIEW). Safe to call again after any failure. */
  async launch(campaignId: string, countries: string[] = ['US', 'CA']) {
    const now = new Date();
    const claimed = await prisma.adCampaign.updateMany({
      where: { id: campaignId, stage: 'DRAFT', OR: [{ launchLockedUntil: null }, { launchLockedUntil: { lt: now } }] },
      data: { launchLockedUntil: new Date(now.getTime() + LAUNCH_LEASE_MS) },
    });
    const c0 = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaignId }, include: { adAccount: { include: { connection: true } }, creatives: true, store: true } });
    if (!claimed.count) return this.view(c0.id); // already launched, or another request is launching it
    const acct = c0.adAccount;
    try {
      if (!acct.connection) throw new ConflictException('Reconnect Meta to launch');
      const meta = this.meta();
      const tag = `sf:${c0.id}`;
      let c = c0 as AdCampaign;
      await this.withToken(acct.connection, async (t) => {
        if (!c.externalId) {
          const found = await meta.findCampaignByTag(t, acct.externalId, tag);
          const id = found?.id ?? (await meta.createCampaign(t, acct.externalId, { name: c.name, status: 'PAUSED' })).id;
          c = await prisma.adCampaign.update({ where: { id: c.id }, data: { externalId: id } });
        }
        if (!c.externalAdSetId) {
          const id = (await meta.createAdSet(t, acct.externalId, { campaignId: c.externalId!, name: `${c.name} · ad set`, dailyBudgetMinor: c.dailyBudgetCents, pixelId: acct.pixelId!, countries, status: 'PAUSED' })).id;
          c = await prisma.adCampaign.update({ where: { id: c.id }, data: { externalAdSetId: id } });
        }
        if (!c.externalCreativeId) {
          const cr = c0.creatives[0];
          const { origin, shopPath } = await DomainsService.storeUrls(c0.store);
          const link = `${origin}${shopPath === '/' ? '' : shopPath}/p/${c.storeProductId}?utm_source=meta&utm_medium=paid&utm_campaign=sf_${c.id}`;
          const imageUrl = cr?.assetUrl?.startsWith('/') ? `${origin}${cr.assetUrl}` : cr?.assetUrl;
          const id = (await meta.createCreative(t, acct.externalId, { name: `${c.name} · creative`, pageId: acct.pageId!, link, headline: cr?.headline ?? c.name, message: cr?.body ?? '', imageUrl })).id;
          c = await prisma.adCampaign.update({ where: { id: c.id }, data: { externalCreativeId: id } });
        }
        if (!c.externalAdId) {
          const id = (await meta.createAd(t, acct.externalId, { name: `${c.name} · ad`, adSetId: c.externalAdSetId!, creativeId: c.externalCreativeId!, status: 'PAUSED' })).id;
          c = await prisma.adCampaign.update({ where: { id: c.id }, data: { externalAdId: id } });
        }
        // Children first, campaign last: nothing spends until everything exists.
        for (const id of [c.externalAdId!, c.externalAdSetId!, c.externalId!]) await meta.setStatus(t, id, 'ACTIVE');
      });
      await prisma.adCampaign.update({ where: { id: c.id }, data: { stage: 'REVIEW', launchedAt: new Date(), lastError: null, launchLockedUntil: null, pausedReason: null } });
    } catch (e: any) {
      await prisma.adCampaign.update({ where: { id: campaignId }, data: { lastError: String(e?.message ?? e).slice(0, 500), launchLockedUntil: null } });
      if (e instanceof MetaApiError && e.isTransient) throw new ConflictException(`Meta is busy (${e.message}). Press Launch again; it continues where it stopped.`);
      this.metaError(e);
    }
    return this.view(campaignId);
  }

  private async view(id: string) {
    return prisma.adCampaign.findUniqueOrThrow({ where: { id }, include: { creatives: true } });
  }
  private async owned(organizationId: string, id: string) {
    const c = await prisma.adCampaign.findFirst({ where: { id, store: { organizationId } }, include: { adAccount: { include: { connection: true } } } });
    if (!c) throw new NotFoundException('Campaign not found');
    return c;
  }
  private async setMetaStatus(c: AdCampaign & { adAccount: AdAccount & { connection: AdConnection | null } }, status: MetaStatus) {
    if (!c.externalId) return;
    if (!c.adAccount.connection) throw new ConflictException('Reconnect Meta first');
    await this.withToken(c.adAccount.connection, (t) => this.meta().setStatus(t, c.externalId!, status));
  }

  async pause(organizationId: string, id: string, reason: 'merchant' | 'low_fuel' = 'merchant') {
    const c = await this.owned(organizationId, id);
    if (c.stage === 'DRAFT') {
      // a draft never reached Meta; nothing to pause
      return this.view(c.id);
    }
    if (!LIVE_STAGES.includes(c.stage as any)) return this.view(c.id);
    await this.setMetaStatus(c, 'PAUSED').catch((e) => this.metaError(e));
    await prisma.adCampaign.update({ where: { id }, data: { stage: 'PAUSED', pausedReason: reason } });
    return this.view(id);
  }

  async resume(organizationId: string, id: string) {
    const c = await this.owned(organizationId, id);
    if (c.stage === 'DRAFT') return this.launch(id);
    if (c.stage !== 'PAUSED') return this.view(id);
    await this.requireFuel(organizationId, c.adAccount);
    const owed = await prisma.adChargeDay.aggregate({ where: { campaignId: id, shortfallCents: { gt: 0 } }, _sum: { shortfallCents: true } });
    if ((owed._sum.shortfallCents ?? 0) > 0) throw new ConflictException('Top up Ad Fuel to cover the unpaid spend first');
    await this.setMetaStatus(c, 'ACTIVE').catch((e) => this.metaError(e));
    await prisma.adCampaign.update({ where: { id }, data: { stage: (await this.learned(id)) ? 'STEADY' : 'WARMING', pausedReason: null } });
    return this.view(id);
  }

  private async learned(campaignId: string, now = new Date()) {
    const since = new Date(now.getTime() - 7 * 86_400_000);
    const p = await prisma.adInsightDaily.aggregate({ where: { campaignId, date: { gte: since } }, _sum: { purchases: true } });
    return (p._sum.purchases ?? 0) >= STEADY_PURCHASES_7D;
  }

  // ---------------------------------------------------------------- insights → charges
  /**
   * ads.sync-insights (hourly) / ads.wallet-debit. Pulls the last `lookbackDays` of daily insights
   * (Meta revises recent days), upserts AdInsightDaily, and charges each day's fuel as a delta.
   * Re-running is harmless: upserts + delta charges. Stage moves REVIEW → WARMING → STEADY, or
   * REJECTED when Meta disapproves the ad.
   */
  async syncCampaign(campaignId: string, now = new Date(), lookbackDays = 3) {
    const c = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaignId }, include: { adAccount: { include: { connection: true } } } });
    if (!c.externalId || !c.launchedAt || !c.adAccount.connection) return { skipped: true };
    const meta = this.meta();
    const since = new Date(Math.max(c.launchedAt.getTime(), now.getTime() - lookbackDays * 86_400_000));
    const { rows, status } = await this.withToken(c.adAccount.connection, async (t) => ({
      rows: await meta.insights(t, c.externalId!, { since: day(since), until: day(now) }),
      status: await meta.getCampaign(t, c.externalId!),
    }));
    const charges = [];
    for (const r of rows) {
      const date = new Date(`${r.date_start}T00:00:00Z`);
      const spendCents = toMinor(r.spend);
      const { purchases, revenue } = purchasesOf(r);
      const data = { impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0, spendCents, purchases, revenueCents: toMinor(revenue), syncedAt: now };
      await prisma.adInsightDaily.upsert({ where: { campaignId_date: { campaignId, date } }, update: data, create: { campaignId, date, ...data } });
      // OWNED: Meta bills the merchant's card for spend; fuel pays only the fee. MANAGED: spend + fee.
      const owed = c.adAccount.mode === 'MANAGED' ? { spendCents, feeCents: feeFor(spendCents, 'MANAGED') } : { spendCents: 0, feeCents: feeFor(spendCents, 'OWNED') };
      if (owed.spendCents + owed.feeCents > 0 || (await prisma.adChargeDay.findUnique({ where: { campaignId_date: { campaignId, date } } }))) {
        charges.push({ date: r.date_start, ...(await this.wallet.chargeDay(campaignId, r.date_start, owed)) });
      }
    }
    let stage = c.stage;
    if (status.effectiveStatus === 'DISAPPROVED') stage = 'REJECTED';
    else if (c.stage === 'REVIEW' && status.effectiveStatus === 'ACTIVE') stage = 'WARMING';
    else if (c.stage === 'WARMING' && (await this.learned(campaignId, now))) stage = 'STEADY';
    if (stage !== c.stage) {
      await prisma.adCampaign.update({ where: { id: campaignId }, data: { stage, ...(stage === 'REJECTED' ? { pausedReason: 'rejected', lastError: 'Meta did not approve this ad. Edit the text or image and launch a new one.' } : {}) } });
      if (stage === 'REJECTED') {
        await prisma.adCreative.updateMany({ where: { campaignId }, data: { policyStatus: 'rejected' } });
        const store = await prisma.store.findUniqueOrThrow({ where: { id: c.storeId } });
        await this.notifications.notify({ organizationId: store.organizationId, kind: 'boost_rejected', severity: 'warning', title: 'Meta rejected an ad', body: `${c.name.replace(/ \[sf:[^\]]+\]$/, '')} was not approved by Meta.`, dedupeKey: `boost_rejected:${campaignId}` });
      } else if (stage === 'WARMING') {
        await prisma.adCreative.updateMany({ where: { campaignId }, data: { policyStatus: 'approved' } });
      }
    }
    await prisma.adCampaign.update({ where: { id: campaignId }, data: { lastSyncedAt: now } });
    return { rows: rows.length, charges, stage };
  }

  /** All launched campaigns; claim per campaign so two schedulers don't sync the same one at once. */
  async syncAll(now = new Date(), minIntervalMs = 5 * 60_000) {
    const due = await prisma.adCampaign.findMany({
      where: { externalId: { not: null }, launchedAt: { not: null }, stage: { notIn: ['DRAFT'] }, OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now.getTime() - minIntervalMs) } }] },
      select: { id: true, lastSyncedAt: true, stage: true, updatedAt: true },
      take: 200,
    });
    const out: { id: string; result: string }[] = [];
    for (const c of due) {
      // paused for over 3 days with nothing left to collect: Meta won't revise those days any more
      const claim = await prisma.adCampaign.updateMany({ where: { id: c.id, lastSyncedAt: c.lastSyncedAt }, data: { lastSyncedAt: now } });
      if (!claim.count) continue;
      try {
        const r = await this.syncCampaign(c.id, now);
        out.push({ id: c.id, result: 'skipped' in r ? 'skipped' : `${r.rows} day(s), stage ${r.stage}` });
      } catch (e: any) {
        await prisma.adCampaign.update({ where: { id: c.id }, data: { lastError: String(e?.message ?? e).slice(0, 500) } });
        out.push({ id: c.id, result: `error: ${e?.message ?? e}` });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- fuel signals
  /** ads.low-fuel: fuel couldn't cover a charge → pause every fuel-funded campaign of the org, notify once. */
  async onFuelEmpty(walletId: string) {
    const w = await prisma.adWallet.findUniqueOrThrow({ where: { id: walletId } });
    const live = await prisma.adCampaign.findMany({ where: { store: { organizationId: w.organizationId }, stage: { in: [...LIVE_STAGES] } }, include: { adAccount: { include: { connection: true } } } });
    let paused = 0;
    for (const c of live) {
      if (!usesFuel(c.adAccount.mode)) continue;
      await this.setMetaStatus(c, 'PAUSED').catch((e) => this.logger.warn(`low-fuel pause ${c.id} on Meta failed: ${e?.message ?? e}`));
      const r = await prisma.adCampaign.updateMany({ where: { id: c.id, stage: { in: [...LIVE_STAGES] } }, data: { stage: 'PAUSED', pausedReason: 'low_fuel' } });
      paused += r.count;
    }
    const episode = await prisma.adWallet.updateMany({ where: { id: walletId, lowFuelAt: null }, data: { lowFuelAt: new Date() } });
    if (episode.count) {
      await this.notifications.notify({
        organizationId: w.organizationId, kind: 'fuel_empty', severity: 'warning',
        title: 'Ad Fuel is empty: Boost is paused',
        body: paused ? `${paused} campaign${paused === 1 ? '' : 's'} paused. Top up Ad Fuel (or turn on auto-reload) and they resume automatically.` : 'Top up Ad Fuel to keep Boost running.',
        dedupeKey: `fuel_empty:${walletId}:${Date.now()}`,
      });
    }
    return { paused };
  }

  /** Fuel added → collect shortfalls, then resume campaigns that were paused only for low fuel. */
  async onFuelAdded(walletId: string) {
    await this.wallet.settleShortfalls(walletId);
    const w = await prisma.adWallet.findUniqueOrThrow({ where: { id: walletId } });
    const open = await prisma.adChargeDay.aggregate({ where: { walletId, shortfallCents: { gt: 0 } }, _sum: { shortfallCents: true } });
    if ((open._sum.shortfallCents ?? 0) > 0 || w.balanceCents + w.bonusCents <= 0) return { resumed: 0 };
    await prisma.adWallet.update({ where: { id: walletId }, data: { lowFuelAt: null } });
    const paused = await prisma.adCampaign.findMany({ where: { store: { organizationId: w.organizationId }, stage: 'PAUSED', pausedReason: 'low_fuel' }, include: { adAccount: { include: { connection: true } } } });
    let resumed = 0;
    for (const c of paused) {
      try {
        await this.setMetaStatus(c, 'ACTIVE');
        const r = await prisma.adCampaign.updateMany({ where: { id: c.id, stage: 'PAUSED', pausedReason: 'low_fuel' }, data: { stage: (await this.learned(c.id)) ? 'STEADY' : 'WARMING', pausedReason: null } });
        resumed += r.count;
      } catch (e: any) {
        this.logger.warn(`resume ${c.id} after top-up failed: ${e?.message ?? e}`);
      }
    }
    return { resumed };
  }

  /** Dev/stub only: the Meta "Test events" view for the selected Pixel. */
  async testEvents(organizationId: string, storeId: string) {
    await this.store(organizationId, storeId);
    const a = await prisma.adAccount.findUnique({ where: { storeId_channel_mode: { storeId, channel: 'META', mode: 'OWNED' } } });
    const m = this.meta() as any;
    if (!a?.pixelId) return { mode: m.mode, events: [] };
    if (m.mode !== 'stub' || typeof m.testEvents !== 'function') {
      return { mode: 'live', events: [], eventsManagerUrl: `https://business.facebook.com/events_manager2/list/dataset/${a.pixelId}/test_events` };
    }
    return { mode: 'stub', pixelId: a.pixelId, testEventCode: a.testEventCode, events: m.testEvents(a.pixelId) };
  }
}
