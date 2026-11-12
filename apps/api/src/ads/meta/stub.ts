import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MetaApiError, META_SCOPES, type CapiEvent, type CapiResult, type MetaAdAccount, type MetaInsightRow,
  type MetaMarketingClient, type MetaStatus,
} from './types';

type Obj = { id: string; kind: 'campaign' | 'adset' | 'creative' | 'ad'; account: string; name: string; status: MetaStatus; parent?: string; budgetMinor?: number; spans: { from: number; to: number | null }[]; createdAt: number; disapproved?: boolean };
type TestEvent = { pixelId: string; eventName: string; eventId: string; source: 'server' | 'browser'; testEventCode: string | null; receivedAt: number; deduplicated: boolean };
type State = { seq: number; tokens: Record<string, { userId: string; exp: number }>; objects: Record<string, Obj>; events: TestEvent[] };

const ACCOUNTS: MetaAdAccount[] = [
  { id: 'act_1029384756', accountId: '1029384756', name: 'Juniper Goods — Ads', currency: 'USD', accountStatus: 1, timezone: 'America/Regina', businessName: 'Juniper Goods Co.' },
  { id: 'act_5647382910', accountId: '5647382910', name: 'Old agency account', currency: 'USD', accountStatus: 2, timezone: 'America/New_York', businessName: null },
];
const PIXELS: Record<string, { id: string; name: string }[]> = {
  act_1029384756: [{ id: '873462519203', name: 'Juniper Goods Pixel' }],
  act_5647382910: [],
};
const HEX64 = /^[0-9a-f]{64}$/;
const DAY = 86_400_000;

/** Deterministic 0..1 from a string */
const unit = (s: string) => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) / 0xffffffff;

/**
 * Stub Meta Marketing API. Same interface and data shapes as the live client; state lives in memory
 * (tests) or in a small JSON file (dev, so campaigns survive an API restart). Spend accrues only
 * while a campaign is ACTIVE, at ~75–100% of its daily budget, like real delivery.
 */
export class StubMetaClient implements MetaMarketingClient {
  readonly mode = 'stub' as const;
  now: () => number = () => Date.now();
  /** Test hook: make the next call to `method` throw */
  failNext: Partial<Record<keyof MetaMarketingClient, Error>> = {};
  private state: State = { seq: 1000, tokens: {}, objects: {}, events: [] };

  constructor(private readonly file: string | null = process.env.NODE_ENV === 'test' ? null : process.env.META_STUB_STATE_FILE ?? join(process.cwd(), '.stub-meta.json')) {
    if (file && existsSync(file)) {
      try { this.state = { ...this.state, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* fresh */ }
    }
  }
  private save() {
    if (this.file) writeFileSync(this.file, JSON.stringify(this.state));
  }
  private trip(m: keyof MetaMarketingClient) {
    const e = this.failNext[m];
    if (e) { delete this.failNext[m]; throw e; }
  }
  private auth(token: string) {
    const t = this.state.tokens[token];
    if (!t || t.exp < this.now()) throw new MetaApiError('Error validating access token: Session has expired or the user has changed their password.', { status: 400, code: 190, type: 'OAuthException' });
    return t;
  }
  private acct(id: string) {
    const a = ACCOUNTS.find((x) => x.id === id);
    if (!a) throw new MetaApiError(`Unsupported get request. Object with ID '${id}' does not exist`, { status: 400, code: 100, subcode: 33 });
    if (a.accountStatus !== 1) throw new MetaApiError('The ad account is disabled', { status: 400, code: 1487390 });
    return a;
  }
  private id() {
    this.state.seq += 1;
    return `${238500000000000 + this.state.seq}`;
  }
  private obj(id: string) {
    const o = this.state.objects[id];
    if (!o) throw new MetaApiError(`Unsupported post request. Object with ID '${id}' does not exist`, { status: 400, code: 100, subcode: 33 });
    return o;
  }

  authorizeUrl(o: { state: string; redirectUri: string }) {
    const admin = (process.env.ADMIN_URL ?? 'http://localhost:3001').replace(/\/$/, '');
    const q = new URLSearchParams({ state: o.state, redirect_uri: o.redirectUri, scope: META_SCOPES.join(',') });
    return `${admin}/boost/connect/stub?${q}`;
  }

  async exchangeCode(o: { code: string; redirectUri: string }) {
    this.trip('exchangeCode');
    if (!o.code.startsWith('stub_code_')) throw new MetaApiError('Invalid verification code format.', { status: 400, code: 100, type: 'OAuthException' });
    const token = `stub_token_${randomBytes(12).toString('hex')}`;
    const exp = this.now() + 60 * DAY;
    this.state.tokens[token] = { userId: '10224466880011', exp };
    this.save();
    return { accessToken: token, expiresAt: new Date(exp), scopes: [...META_SCOPES] };
  }

  async me(token: string) {
    this.auth(token);
    return { id: '10224466880011', name: 'Jeff Allin (test user)' };
  }
  async listAdAccounts(token: string) {
    this.trip('listAdAccounts');
    this.auth(token);
    return ACCOUNTS;
  }
  async listPages(token: string) {
    this.auth(token);
    return [{ id: '104857600123456', name: 'Juniper Goods' }];
  }
  async listPixels(token: string, adAccountId: string) {
    this.auth(token);
    this.acct(adAccountId);
    return PIXELS[adAccountId] ?? [];
  }
  async findCampaignByTag(token: string, adAccountId: string, tag: string) {
    this.auth(token);
    const o = Object.values(this.state.objects).find((x) => x.kind === 'campaign' && x.account === adAccountId && x.name.includes(tag));
    return o ? { id: o.id } : null;
  }
  private create(kind: Obj['kind'], account: string, name: string, status: MetaStatus, extra: Partial<Obj> = {}) {
    const id = this.id();
    const t = this.now();
    this.state.objects[id] = { id, kind, account, name, status, spans: status === 'ACTIVE' ? [{ from: t, to: null }] : [], createdAt: t, ...extra };
    this.save();
    return { id };
  }
  async createCampaign(token: string, adAccountId: string, o: { name: string; status: MetaStatus }) {
    this.auth(token);
    this.acct(adAccountId);
    const r = this.create('campaign', adAccountId, o.name, o.status);
    // Like a timeout after Meta created it: object exists, caller sees an error.
    this.trip('createCampaign');
    return r;
  }
  async createAdSet(token: string, adAccountId: string, o: { campaignId: string; name: string; dailyBudgetMinor: number; pixelId: string; countries: string[]; status: MetaStatus }) {
    this.trip('createAdSet');
    this.auth(token);
    this.obj(o.campaignId);
    if (o.dailyBudgetMinor < 100) throw new MetaApiError('Your budget is too low. The minimum budget for this ad set is $1.00.', { status: 400, code: 100, subcode: 1885272 });
    if (!(PIXELS[adAccountId] ?? []).some((p) => p.id === o.pixelId)) throw new MetaApiError('Invalid pixel id for promoted_object', { status: 400, code: 100, subcode: 1487007 });
    return this.create('adset', adAccountId, o.name, o.status, { parent: o.campaignId, budgetMinor: o.dailyBudgetMinor });
  }
  async createCreative(token: string, adAccountId: string, o: { name: string; pageId: string; link: string; message: string; headline: string }) {
    this.trip('createCreative');
    this.auth(token);
    if (!/^https?:\/\//.test(o.link)) throw new MetaApiError('link_data.link must be a valid URL', { status: 400, code: 100, subcode: 1443048 });
    // Meta's policy review flags these; the campaign becomes DISAPPROVED after launch.
    const disapproved = /\b(cure|guaranteed|miracle|lose \d+ ?(lb|kg))\b/i.test(`${o.message} ${o.headline}`);
    return this.create('creative', adAccountId, o.name, 'ACTIVE', { disapproved });
  }
  async createAd(token: string, adAccountId: string, o: { name: string; adSetId: string; creativeId: string; status: MetaStatus }) {
    this.trip('createAd');
    this.auth(token);
    const adset = this.obj(o.adSetId);
    const creative = this.obj(o.creativeId);
    if (creative.disapproved) this.obj(adset.parent!).disapproved = true;
    return this.create('ad', adAccountId, o.name, o.status, { parent: o.adSetId });
  }
  async setStatus(token: string, objectId: string, status: MetaStatus) {
    this.trip('setStatus');
    this.auth(token);
    const o = this.obj(objectId);
    const t = this.now();
    if (o.status !== status) {
      if (status === 'ACTIVE') o.spans.push({ from: t, to: null });
      else { const open = o.spans.find((s) => s.to === null); if (open) open.to = t; }
      o.status = status;
      this.save();
    }
  }
  async getCampaign(token: string, campaignId: string) {
    this.auth(token);
    const o = this.obj(campaignId);
    const effectiveStatus = o.disapproved ? 'DISAPPROVED' : o.status === 'ACTIVE' && this.now() - (o.spans.at(-1)?.from ?? 0) < 60_000 ? 'IN_PROCESS' : o.status;
    return { id: o.id, status: o.status, effectiveStatus };
  }
  async insights(token: string, campaignId: string, range: { since: string; until: string }): Promise<MetaInsightRow[]> {
    this.trip('insights');
    this.auth(token);
    const c = this.obj(campaignId);
    const adset = Object.values(this.state.objects).find((x) => x.kind === 'adset' && x.parent === campaignId);
    const budget = adset?.budgetMinor ?? 0;
    const rows: MetaInsightRow[] = [];
    const now = this.now();
    for (let d = Date.parse(`${range.since}T00:00:00Z`); d <= Date.parse(`${range.until}T00:00:00Z`); d += DAY) {
      const end = Math.min(d + DAY, now);
      let activeMs = 0;
      if (!c.disapproved) {
        for (const s of c.spans) activeMs += Math.max(0, Math.min(end, s.to ?? now) - Math.max(d, s.from));
      }
      if (activeMs <= 0) continue;
      const date = new Date(d).toISOString().slice(0, 10);
      const pace = 0.75 + 0.25 * unit(`${campaignId}:${date}`);
      const spendMinor = Math.floor((budget * pace * activeMs) / DAY);
      const impressions = Math.floor((spendMinor / 1200) * 1000); // ~$12 CPM
      const clicks = Math.floor(impressions * (0.011 + 0.008 * unit(`c${campaignId}${date}`)));
      const purchases = Math.floor(spendMinor / 2600); // ~$26 CPA
      rows.push({
        date_start: date, date_stop: date,
        impressions: String(impressions), clicks: String(clicks), spend: (spendMinor / 100).toFixed(2),
        actions: purchases ? [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: String(purchases) }] : [],
        action_values: purchases ? [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: (purchases * 46.5).toFixed(2) }] : [],
      });
    }
    return rows;
  }

  /** Validates like Meta's CAPI endpoint and records into the "Test events" view. */
  async sendEvents(token: string, pixelId: string, events: CapiEvent[], testEventCode?: string | null): Promise<CapiResult> {
    this.trip('sendEvents');
    this.auth(token);
    if (!Object.values(PIXELS).flat().some((p) => p.id === pixelId)) throw new MetaApiError(`Unsupported post request. Object with ID '${pixelId}' does not exist`, { status: 400, code: 100, subcode: 33 });
    const now = this.now();
    for (const e of events) {
      const bad = (m: string) => { throw new MetaApiError(`Invalid parameter: ${m}`, { status: 400, code: 100, subcode: 2804003 }); };
      if (!e.event_name || !e.event_id) bad('event_name and event_id are required');
      if (e.event_time * 1000 < now - 7 * DAY) bad('event_time is more than 7 days in the past');
      if (e.event_time * 1000 > now + 60_000) bad('event_time is in the future');
      if (e.action_source === 'website' && !e.user_data.client_user_agent) bad('client_user_agent is required for website events');
      for (const k of ['em', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'external_id'] as const) {
        for (const v of e.user_data[k] ?? []) if (!HEX64.test(v)) bad(`user_data.${k} must be SHA-256 hashed`);
      }
    }
    for (const e of events) this.record(pixelId, e.event_name, e.event_id, 'server', testEventCode ?? null);
    this.save();
    return { events_received: events.length, messages: [], fbtrace_id: `Stub${randomBytes(8).toString('hex')}` };
  }

  /** Dev only: the storefront's stub pixel reports browser events here (real Meta Pixel in live mode). */
  recordBrowserEvent(pixelId: string, eventName: string, eventId: string, testEventCode: string | null) {
    this.record(pixelId, eventName, eventId, 'browser', testEventCode);
    this.save();
  }
  private record(pixelId: string, eventName: string, eventId: string, source: 'server' | 'browser', testEventCode: string | null) {
    const t = this.now();
    // Meta dedupes a browser + server pair with the same event_name + event_id within 48 h.
    const twin = this.state.events.find((x) => x.pixelId === pixelId && x.eventName === eventName && x.eventId === eventId && t - x.receivedAt < 2 * DAY);
    const deduplicated = Boolean(twin);
    this.state.events.push({ pixelId, eventName, eventId, source, testEventCode, receivedAt: t, deduplicated });
    if (this.state.events.length > 500) this.state.events = this.state.events.slice(-500);
  }
  testEvents(pixelId: string) {
    return this.state.events.filter((e) => e.pixelId === pixelId).slice(-50).reverse();
  }
}
