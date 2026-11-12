import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { AdSim, latency, utcDay } from '../sim';
import { fromMajor, TikTokError, toMajor, type TikTokClient } from './types';

const HEX64 = /^[0-9a-f]{64}$/;
/** Live platforms require https; the stub also accepts dev hosts (localhost, *.local) so the demo works. */
const okUrl = (u: string) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1|[\w.-]+\.local)(:\d+)?\//.test(u);
const POLICY = /\b(cure[sd]?|miracle|guaranteed? (results|income)|lose \d+ ?(lb|kg|pounds))\b/i;
const need = (body: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (body[k] === undefined || body[k] === null || body[k] === '') throw new TikTokError(`${k}: Missing data for required field.`, 40002);
};

/**
 * Stub TikTok API for Business v1.3: same paths, params and envelope data as the live API; delivery
 * from AdSim. The advertiser's prepaid balance (topped up / deducted by BC transfers) is the spend
 * ceiling: cap = lifetime spend + balance, so a TikTok account can never outspend what we moved in.
 * Ads go through review (STUB_ADS_REVIEW_MS); prohibited claims are rejected (AD_STATUS_AUDIT_DENY).
 */
export class StubTikTok implements TikTokClient {
  readonly mode = 'stub' as const;
  readonly sim: AdSim;
  failNext: Partial<Record<string, Error>> = {};
  failAfterCommit: Partial<Record<string, Error>> = {};
  constructor(file: string | null = process.env.NODE_ENV === 'test' ? null : process.env.TIKTOK_STUB_STATE_FILE ?? join(process.cwd(), '.stub-tiktok.json')) {
    this.sim = new AdSim(file);
  }
  private get o() { return this.sim.state.objects; }
  private adv(id: unknown) {
    const a = this.sim.account(String(id));
    if (!a) throw new TikTokError('Advertiser does not exist or you do not have permission.', 40001);
    return a;
  }
  private byRequest(kind: string, advertiser: string, requestId: unknown) {
    if (!requestId) return null;
    return Object.values(this.o).find((x: any) => x.kind === kind && x.advertiser === advertiser && x.requestId === String(requestId)) ?? null;
  }
  private balance(advertiserId: string) {
    const cap = this.sim.cap(advertiserId) ?? 0;
    return Math.max(0, cap - this.sim.accountSpend(advertiserId));
  }

  async get<T = any>(path: string, p: Record<string, unknown>): Promise<T> { return this.route('GET', path, p) as Promise<T>; }
  async post<T = any>(path: string, b: Record<string, unknown>): Promise<T> { return this.route('POST', path, b) as Promise<T>; }

  private async route(method: string, path: string, b: Record<string, any>): Promise<any> {
    await latency();
    const e = this.failNext[path];
    if (e) { delete this.failNext[path]; throw e; }
    const out = this.handle(method, path, b);
    this.sim.save();
    const after = this.failAfterCommit[path];
    if (after) { delete this.failAfterCommit[path]; throw after; }
    return out;
  }

  private handle(method: string, path: string, b: Record<string, any>): any {
    const key = `${method} ${path}`;
    switch (key) {
      case 'POST /bc/advertiser/create/': {
        need(b, 'bc_id', 'advertiser_info', 'customer_info');
        const info = b.advertiser_info;
        need(info, 'name', 'currency', 'timezone');
        const id = this.sim.nextId(7_300_000_000);
        this.sim.addAccount({ id, name: info.name, currency: info.currency, timezone: info.timezone, extra: { bc: b.bc_id } });
        return { advertiser_id: id };
      }
      case 'GET /bc/asset/get/': {
        need(b, 'bc_id', 'asset_type');
        const kw = (typeof b.filtering === 'string' ? JSON.parse(b.filtering) : b.filtering ?? {}).keyword as string | undefined;
        const list = Object.values(this.sim.state.accounts).filter((a) => a.extra?.bc === b.bc_id && (!kw || a.name.includes(kw))).map((a) => ({ asset_id: a.id, asset_name: a.name, asset_type: 'ADVERTISER', advertiser_status: 'STATUS_ENABLE' }));
        return { list, page_info: { page: 1, page_size: 50, total_number: list.length, total_page: 1 } };
      }
      case 'POST /pixel/create/': {
        need(b, 'advertiser_id', 'pixel_name');
        this.adv(b.advertiser_id);
        const existing = Object.values(this.o).find((x: any) => x.kind === 'pixel' && x.advertiser === b.advertiser_id && x.name === b.pixel_name) as any;
        if (existing) throw new TikTokError('Pixel name already exists.', 40002);
        const pixel_id = this.sim.nextId(7_000_000_000);
        const pixel_code = `C${randomBytes(9).toString('hex').toUpperCase().slice(0, 19)}`;
        this.o[`px/${pixel_code}`] = { kind: 'pixel', advertiser: b.advertiser_id, name: b.pixel_name, pixel_id, pixel_code };
        return { pixel_id, pixel_code };
      }
      case 'GET /pixel/list/': {
        need(b, 'advertiser_id');
        const pixels = Object.values(this.o).filter((x: any) => x.kind === 'pixel' && x.advertiser === b.advertiser_id && (!b.name || x.name === b.name)).map((x: any) => ({ pixel_id: x.pixel_id, pixel_code: x.pixel_code, pixel_name: x.name }));
        return { pixels, page_info: { total_number: pixels.length } };
      }
      case 'POST /catalog/create/': {
        need(b, 'bc_id', 'catalog_name', 'catalog_conf');
        const existing = Object.values(this.o).find((x: any) => x.kind === 'catalog' && x.bc === b.bc_id && x.name === b.catalog_name) as any;
        if (existing) return { catalog_id: existing.catalog_id };
        const catalog_id = this.sim.nextId(7_100_000_000);
        this.o[`cat/${catalog_id}`] = { kind: 'catalog', bc: b.bc_id, name: b.catalog_name, catalog_id, products: {} };
        return { catalog_id };
      }
      case 'POST /catalog/product/upload/': {
        need(b, 'bc_id', 'catalog_id', 'products');
        const cat = this.o[`cat/${b.catalog_id}`];
        if (!cat) throw new TikTokError('Catalog does not exist.', 40002);
        for (const p of b.products as any[]) {
          need(p, 'sku_id', 'title', 'description', 'availability', 'image_url', 'price', 'landing_page');
          const issues: string[] = [];
          if (!okUrl(p.image_url)) issues.push('image_url must be https');
          if (!okUrl(p.landing_page?.landing_page_url ?? '')) issues.push('landing_page_url must be https');
          if (POLICY.test(`${p.title} ${p.description}`)) issues.push('Exaggerated or misleading claims');
          cat.products[p.sku_id] = { sku_id: p.sku_id, at: this.sim.now(), issues };
        }
        return { feed_log_id: this.sim.nextId(9_100_000_000) };
      }
      case 'GET /catalog/product/get/': {
        need(b, 'bc_id', 'catalog_id');
        const cat = this.o[`cat/${b.catalog_id}`];
        if (!cat) throw new TikTokError('Catalog does not exist.', 40002);
        const now = this.sim.now();
        const products = Object.values(cat.products as Record<string, any>).map((x) => ({ sku_id: x.sku_id, audit_status: x.issues.length ? 'REJECTED' : now - x.at < this.sim.reviewMs ? 'PROCESSING' : 'APPROVED', reject_reasons: x.issues }));
        return { list: products, page_info: { total_number: products.length } };
      }
      case 'POST /identity/create/': {
        need(b, 'advertiser_id', 'display_name');
        this.adv(b.advertiser_id);
        const ex = Object.values(this.o).find((x: any) => x.kind === 'identity' && x.advertiser === b.advertiser_id && x.name === b.display_name) as any;
        if (ex) return { identity_id: ex.identity_id };
        const identity_id = randomBytes(16).toString('hex');
        this.o[`id/${identity_id}`] = { kind: 'identity', advertiser: b.advertiser_id, name: b.display_name, identity_id };
        return { identity_id };
      }
      case 'POST /file/image/ad/upload/': {
        need(b, 'advertiser_id', 'upload_type', 'image_url');
        if (!/^https?:\/\//.test(b.image_url)) throw new TikTokError('Invalid image url.', 40002);
        const image_id = `ad-site-i18n-sg/${randomBytes(12).toString('hex')}`;
        return { image_id, width: 1080, height: 1920, format: 'png', signature: randomBytes(16).toString('hex') };
      }
      case 'GET /campaign/get/': {
        need(b, 'advertiser_id');
        const f = typeof b.filtering === 'string' ? JSON.parse(b.filtering) : b.filtering ?? {};
        const list = Object.values(this.o).filter((x: any) => x.kind === 'campaign' && x.advertiser === b.advertiser_id && (!f.campaign_name || x.name.includes(f.campaign_name)) && (!f.campaign_ids || f.campaign_ids.includes(x.id)))
          .map((x: any) => ({ campaign_id: x.id, campaign_name: x.name, objective_type: x.objective, operation_status: x.status, secondary_status: x.status === 'ENABLE' ? 'CAMPAIGN_STATUS_ENABLE' : 'CAMPAIGN_STATUS_DISABLE' }));
        return { list, page_info: { total_number: list.length } };
      }
      case 'POST /campaign/create/': {
        need(b, 'advertiser_id', 'campaign_name', 'objective_type', 'budget_mode');
        this.adv(b.advertiser_id);
        const dup = this.byRequest('campaign', b.advertiser_id, b.request_id) as any;
        if (dup) return { campaign_id: dup.id }; // request_id = idempotency key
        const id = this.sim.nextId(1_800_000_000_000);
        this.o[`c/${id}`] = { kind: 'campaign', id, advertiser: b.advertiser_id, name: b.campaign_name, objective: b.objective_type, status: b.operation_status ?? 'ENABLE', requestId: b.request_id ? String(b.request_id) : null };
        return { campaign_id: id };
      }
      case 'GET /adgroup/get/': {
        need(b, 'advertiser_id');
        const f = typeof b.filtering === 'string' ? JSON.parse(b.filtering) : b.filtering ?? {};
        const list = Object.values(this.o).filter((x: any) => x.kind === 'adgroup' && x.advertiser === b.advertiser_id && (!f.campaign_ids || f.campaign_ids.includes(x.campaign)) && (!f.adgroup_name || x.name.includes(f.adgroup_name)))
          .map((x: any) => ({ adgroup_id: x.id, adgroup_name: x.name, campaign_id: x.campaign, budget: toMajor(this.sim.budget(x.id)), operation_status: this.sim.isActive(x.id) ? 'ENABLE' : 'DISABLE' }));
        return { list, page_info: { total_number: list.length } };
      }
      case 'POST /adgroup/create/': {
        need(b, 'advertiser_id', 'campaign_id', 'adgroup_name', 'budget_mode', 'budget', 'optimization_goal', 'billing_event', 'location_ids', 'schedule_type', 'schedule_start_time');
        const camp = this.o[`c/${b.campaign_id}`];
        if (!camp) throw new TikTokError('Campaign does not exist.', 40002);
        if (b.optimization_goal === 'CONVERT' && !(b.pixel_id && b.optimization_event)) throw new TikTokError('pixel_id and optimization_event are required for CONVERT.', 40002);
        const minor = fromMajor(b.budget);
        if (b.budget_mode === 'BUDGET_MODE_DAY' && minor < 2000) throw new TikTokError('Ad group daily budget must be at least 20 USD.', 40002);
        const dup = this.byRequest('adgroup', b.advertiser_id, b.request_id) as any;
        if (dup) return { adgroup_id: dup.id };
        const id = this.sim.nextId(1_810_000_000_000);
        this.o[`g/${id}`] = { kind: 'adgroup', id, advertiser: b.advertiser_id, campaign: b.campaign_id, name: b.adgroup_name, requestId: b.request_id ? String(b.request_id) : null };
        // delivery unit in the simulator = the ad group (ENABLE once an ad is attached and approved)
        this.sim.addCampaign({ id, account: b.advertiser_id, name: b.adgroup_name, budgetMinor: minor, active: false });
        return { adgroup_id: id };
      }
      case 'POST /adgroup/budget/update/': {
        need(b, 'advertiser_id', 'budget');
        for (const u of b.budget as { adgroup_id: string; budget: number }[]) {
          if (!this.o[`g/${u.adgroup_id}`]) throw new TikTokError('Ad group does not exist.', 40002);
          const minor = fromMajor(u.budget);
          if (minor < 2000) throw new TikTokError('Ad group daily budget must be at least 20 USD.', 40002);
          this.sim.setBudget(u.adgroup_id, minor);
        }
        return {};
      }
      case 'GET /ad/get/': {
        need(b, 'advertiser_id');
        const f = typeof b.filtering === 'string' ? JSON.parse(b.filtering) : b.filtering ?? {};
        const list = Object.values(this.o).filter((x: any) => x.kind === 'ad' && x.advertiser === b.advertiser_id && (!f.adgroup_ids || f.adgroup_ids.includes(x.adgroup)) && (!f.ad_name || x.name.includes(f.ad_name)))
          .map((x: any) => {
            const sc = this.sim.campaign(x.adgroup);
            const review = sc ? this.sim.reviewOf(sc) : 'PENDING';
            const on = this.sim.isActive(x.adgroup);
            const secondary_status = review === 'DISAPPROVED' ? 'AD_STATUS_AUDIT_DENY' : review === 'PENDING' ? 'AD_STATUS_REVIEW' : on ? 'AD_STATUS_DELIVERY_OK' : 'AD_STATUS_DISABLE';
            return { ad_id: x.id, ad_name: x.name, adgroup_id: x.adgroup, operation_status: on ? 'ENABLE' : 'DISABLE', secondary_status, ...(review === 'DISAPPROVED' ? { reject_info: x.rejectInfo } : {}) };
          });
        return { list, page_info: { total_number: list.length } };
      }
      case 'POST /ad/create/': {
        need(b, 'advertiser_id', 'adgroup_id', 'creatives');
        const g = this.o[`g/${b.adgroup_id}`];
        if (!g) throw new TikTokError('Ad group does not exist.', 40002);
        const dup = Object.values(this.o).find((x: any) => x.kind === 'ad' && x.adgroup === b.adgroup_id && x.requestId && x.requestId === String(b.request_id ?? '')) as any;
        if (dup) return { ad_ids: [dup.id] };
        const ad_ids: string[] = [];
        for (const c of b.creatives as any[]) {
          need(c, 'ad_name', 'identity_type', 'identity_id', 'ad_format', 'ad_text', 'landing_page_url', 'call_to_action');
          if (!Array.isArray(c.image_ids) || !c.image_ids.length) throw new TikTokError('image_ids: at least one image is required for this ad format.', 40002);
          if (String(c.ad_text).length > 100) throw new TikTokError('ad_text: Length must be between 1 and 100.', 40002);
          const id = this.sim.nextId(1_820_000_000_000);
          const denied = POLICY.test(c.ad_text);
          this.o[`a/${id}`] = { kind: 'ad', id, advertiser: b.advertiser_id, adgroup: b.adgroup_id, name: c.ad_name, requestId: b.request_id ? String(b.request_id) : null, rejectInfo: denied ? [{ reason: 'Exaggerated or misleading claims', suggestion: 'Remove absolute or medical claims' }] : undefined };
          const sc = this.sim.campaign(b.adgroup_id)!;
          if (denied) sc.review = 'DISAPPROVED';
          ad_ids.push(id);
        }
        return { ad_ids };
      }
      case 'POST /campaign/status/update/': {
        need(b, 'advertiser_id', 'campaign_ids', 'operation_status');
        for (const id of b.campaign_ids as string[]) {
          const c = this.o[`c/${id}`];
          if (!c) throw new TikTokError('Campaign does not exist.', 40002);
          c.status = b.operation_status;
          for (const g of Object.values(this.o).filter((x: any) => x.kind === 'adgroup' && x.campaign === id) as any[]) this.sim.setActive(g.id, b.operation_status === 'ENABLE');
        }
        return { campaign_ids: b.campaign_ids };
      }
      case 'GET /report/integrated/get/': {
        need(b, 'advertiser_id', 'report_type', 'data_level', 'dimensions');
        const dims: string[] = typeof b.dimensions === 'string' ? JSON.parse(b.dimensions) : b.dimensions;
        const f = (typeof b.filtering === 'string' ? JSON.parse(b.filtering) : b.filtering ?? []) as { field_name: string; filter_type: string; filter_value: string }[];
        const campIds: string[] | null = f.find((x) => x.field_name === 'campaign_ids') ? JSON.parse(f.find((x) => x.field_name === 'campaign_ids')!.filter_value) : null;
        if (b.data_level === 'AUCTION_ADVERTISER' && (b.query_lifetime === true || b.query_lifetime === 'true')) {
          return { list: [{ dimensions: { advertiser_id: b.advertiser_id }, metrics: { spend: toMajor(this.sim.accountSpend(String(b.advertiser_id))).toFixed(2) } }], page_info: { total_number: 1 } };
        }
        need(b, 'start_date', 'end_date');
        const list: any[] = [];
        for (const c of Object.values(this.o).filter((x: any) => x.kind === 'campaign' && x.advertiser === b.advertiser_id && (!campIds || campIds.includes(x.id))) as any[]) {
          const byDay = new Map<string, { s: number; i: number; k: number; cv: number; v: number }>();
          for (const g of Object.values(this.o).filter((x: any) => x.kind === 'adgroup' && x.campaign === c.id) as any[]) {
            for (const r of this.sim.daily(g.id, b.start_date, b.end_date)) {
              const d = byDay.get(r.date) ?? { s: 0, i: 0, k: 0, cv: 0, v: 0 };
              d.s += r.spendMinor; d.i += r.impressions; d.k += r.clicks; d.cv += r.conversions; d.v += r.valueMinor;
              byDay.set(r.date, d);
            }
          }
          for (const [date, d] of [...byDay].sort()) {
            list.push({
              dimensions: { campaign_id: c.id, ...(dims.includes('stat_time_day') ? { stat_time_day: `${date} 00:00:00` } : {}) },
              metrics: { spend: toMajor(d.s).toFixed(2), impressions: String(d.i), clicks: String(d.k), complete_payment: String(d.cv), total_complete_payment_rate: d.s ? (d.v / d.s).toFixed(2) : '0.00' },
            });
          }
        }
        return { list, page_info: { page: 1, page_size: 1000, total_number: list.length, total_page: 1 } };
      }
      case 'GET /advertiser/balance/get/': {
        need(b, 'bc_id');
        const ids = Object.values(this.sim.state.accounts).filter((a) => a.extra?.bc === b.bc_id).map((a) => a.id);
        return { advertiser_account_list: ids.map((id) => ({ advertiser_id: id, account_balance: toMajor(this.balance(id)), cash_balance: toMajor(this.balance(id)), grant_balance: 0, currency: this.sim.account(id)!.currency })) };
      }
      case 'POST /bc/transfer/': {
        need(b, 'bc_id', 'advertiser_id', 'transfer_type', 'cash_amount');
        const a = this.adv(b.advertiser_id);
        if (a.extra?.bc !== b.bc_id) throw new TikTokError('The advertiser does not belong to this Business Center.', 40001);
        const minor = fromMajor(b.cash_amount);
        if (!(minor > 0)) throw new TikTokError('cash_amount must be greater than 0.', 40002);
        const bal = this.balance(a.id);
        const spent = this.sim.accountSpend(a.id);
        if (b.transfer_type === 'RECHARGE') this.sim.setCap(a.id, spent + bal + minor);
        else if (b.transfer_type === 'DEDUCT') {
          if (minor > bal) throw new TikTokError('Insufficient advertiser balance for deduction.', 40002);
          this.sim.setCap(a.id, spent + bal - minor);
        } else throw new TikTokError('transfer_type must be RECHARGE or DEDUCT.', 40002);
        return {};
      }
      case 'POST /event/track/': {
        need(b, 'event_source', 'event_source_id', 'data');
        const px = this.o[`px/${b.event_source_id}`];
        if (!px) throw new TikTokError('Pixel does not exist.', 40002);
        for (const d of b.data as any[]) {
          need(d, 'event', 'event_time', 'event_id');
          for (const k of ['email', 'phone', 'external_id']) if (d.user?.[k] !== undefined && !HEX64.test(String(d.user[k]))) throw new TikTokError(`user.${k} must be SHA-256 hashed.`, 40002);
          this.record(px.advertiser, b.event_source_id, d.event, d.event_id, 'server', b.test_event_code);
        }
        return {};
      }
      default:
        throw new TikTokError(`Stub has no route ${key}`, 40002);
    }
  }

  /** TikTok dedupes browser + server events with the same pixel, event and event_id within 48 h. */
  record(advertiser: string, pixelCode: string, event: string, eventId: string, source: 'server' | 'browser', testEventCode?: string | null) {
    const now = this.sim.now();
    const twin = this.sim.state.events.find((e) => e.pixelCode === pixelCode && e.eventName === event && e.eventId === eventId && now - e.receivedAt < 48 * 3600_000);
    this.sim.state.events.push({ advertiser, pixelCode, eventName: event, eventId, source, receivedAt: now, deduplicated: Boolean(twin), testEventCode: testEventCode ?? null });
    if (this.sim.state.events.length > 500) this.sim.state.events = this.sim.state.events.slice(-500);
    this.sim.save();
  }
  testEvents(pixelCode: string) { return this.sim.state.events.filter((e) => e.pixelCode === pixelCode).slice(-50).reverse(); }
  today() { return utcDay(this.sim.now()); }
}
