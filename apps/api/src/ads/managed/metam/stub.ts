import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { AdSim, latency } from '../sim';
import { MetaGraphError, type MetaGraph } from './types';

const POLICY = /\b(cure[sd]?|miracle|guaranteed? (results|income)|lose \d+ ?(lb|kg|pounds))\b/i;
const HEX64 = /^[0-9a-f]{64}$/;
const bad = (m: string, code = 100) => new MetaGraphError(m, 400, code);
const parse = (v: unknown) => (typeof v === 'string' && /^[[{]/.test(v) ? JSON.parse(v) : v);

/** Stub Graph API for managed mode: same paths/fields; ad set = delivery unit; spend_cap from AdSim. */
export class StubMetaGraph implements MetaGraph {
  readonly mode = 'stub' as const;
  readonly sim: AdSim;
  failNext: Partial<Record<string, Error>> = {};
  failAfterCommit: Partial<Record<string, Error>> = {};
  /** Every spend_cap value we were sent (tests: never "0") */
  readonly capWrites: { account: string; value: string }[] = [];
  constructor(file: string | null = process.env.NODE_ENV === 'test' ? null : process.env.META_MANAGED_STUB_STATE_FILE ?? join(process.cwd(), '.stub-meta-managed.json')) {
    this.sim = new AdSim(file);
  }
  private get o() { return this.sim.state.objects; }
  async call<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, unknown> = {}): Promise<T> {
    await latency();
    const p = path.replace(/^\//, '');
    const k = `${method} ${p.replace(/^act_\d+/, 'act').replace(/^\d+/, ':id')}`;
    const f = this.failNext[k];
    if (f) { delete this.failNext[k]; throw f; }
    const out = this.handle(method, p, Object.fromEntries(Object.entries(params).map(([a, b]) => [a, parse(b)])));
    this.sim.save();
    const a = this.failAfterCommit[k];
    if (a) { delete this.failAfterCommit[k]; throw a; }
    return out as T;
  }
  private acct(id: string) {
    const a = this.sim.account(id);
    if (!a) throw bad(`Unsupported request - Object with ID '${id}' does not exist`, 100);
    return a;
  }
  private handle(method: string, p: string, b: Record<string, any>): unknown {
    const [head, edge] = p.split('/');
    // --- Business Manager
    if (/^\d+$/.test(head) && edge === 'adaccount' && method === 'POST') {
      for (const k of ['name', 'currency', 'timezone_id', 'end_advertiser', 'media_agency', 'partner']) if (b[k] === undefined) throw bad(`(#100) The parameter ${k} is required`);
      const n = this.sim.nextId(10_000_000_000);
      this.sim.addAccount({ id: `act_${n}`, name: b.name, currency: b.currency, timezone: String(b.timezone_id), extra: { business: head } });
      return { id: `act_${n}`, account_id: n, business_id: head, end_advertiser_id: b.end_advertiser, media_agency_id: b.media_agency, partner_id: b.partner };
    }
    if (/^\d+$/.test(head) && edge === 'owned_ad_accounts' && method === 'GET') {
      const f: { field: string; operator: string; value: string }[] = b.filtering ?? [];
      const name = f.find((x) => x.field === 'name')?.value;
      return { data: Object.values(this.sim.state.accounts).filter((a) => a.extra?.business === head && (!name || a.name.includes(name))).map((a) => ({ id: a.id, name: a.name, account_status: 1, currency: a.currency })) };
    }
    if (/^\d+$/.test(head) && edge === 'adspixels') {
      if (method === 'POST') {
        if (!b.name) throw bad('(#100) The parameter name is required');
        const id = this.sim.nextId(880_000_000_000);
        this.o[`px/${id}`] = { kind: 'pixel', id, name: b.name, business: head, shared: [] };
        return { id };
      }
      return { data: Object.values(this.o).filter((x: any) => x.kind === 'pixel' && x.business === head).map((x: any) => ({ id: x.id, name: x.name })) };
    }
    if (/^\d+$/.test(head) && edge === 'shared_accounts' && method === 'POST') {
      const px = this.o[`px/${head}`];
      if (!px) throw bad('Pixel not found');
      if (!px.shared.includes(b.account_id)) px.shared.push(String(b.account_id));
      return { success: true };
    }
    if (/^\d+$/.test(head) && edge === 'events' && method === 'POST') {
      const px = this.o[`px/${head}`];
      if (!px) throw bad('Pixel not found');
      for (const e of b.data as any[]) {
        if (!e.event_id || !e.event_name || !e.event_time) throw bad('(#100) event_name, event_time and event_id are required');
        for (const key of ['em', 'ph', 'fn', 'ln', 'external_id']) for (const v of e.user_data?.[key] ?? []) if (!HEX64.test(v)) throw bad(`(#100) user_data.${key} must be hashed`);
        this.record(head, e.event_name, e.event_id, 'server', b.test_event_code ?? null);
      }
      return { events_received: (b.data as any[]).length, messages: [], fbtrace_id: `stub${randomBytes(8).toString('hex')}` };
    }
    // --- Ad account
    if (head.startsWith('act_') && !edge) {
      const a = this.acct(head);
      if (method === 'POST') {
        if (b.spend_cap !== undefined) {
          this.capWrites.push({ account: head, value: String(b.spend_cap) });
          const v = Number(b.spend_cap);
          if (!(v >= 0)) throw bad('(#100) Invalid spend_cap');
          const spent = this.sim.accountSpend(head);
          if (v !== 0 && v < spent) throw bad('(#100) The spend cap must be at least the amount already spent', 100);
          this.sim.setCap(head, v === 0 ? null : v); // Meta: 0 removes the cap
        }
        return { success: true };
      }
      const cap = this.sim.cap(head);
      return { id: head, name: a.name, currency: a.currency, amount_spent: String(this.sim.accountSpend(head)), spend_cap: cap === null ? '0' : String(cap), account_status: 1 };
    }
    if (head.startsWith('act_') && edge) {
      this.acct(head);
      if (method === 'GET' && edge === 'campaigns') {
        const name = (b.filtering ?? []).find((x: any) => x.field === 'name')?.value as string | undefined;
        return { data: Object.values(this.o).filter((x: any) => x.kind === 'campaign' && x.account === head && (!name || x.name.includes(name))).map((x: any) => ({ id: x.id, name: x.name })) };
      }
      if (method === 'GET' && edge === 'adsets') {
        const name = (b.filtering ?? []).find((x: any) => x.field === 'name')?.value as string | undefined;
        return { data: Object.values(this.o).filter((x: any) => x.kind === 'adset' && x.account === head && (!name || x.name.includes(name))).map((x: any) => ({ id: x.id, name: x.name })) };
      }
      if (method === 'POST' && edge === 'campaigns') {
        if (b.objective !== 'OUTCOME_SALES' || !Array.isArray(b.special_ad_categories)) throw bad('(#100) objective OUTCOME_SALES and special_ad_categories are required');
        const id = this.sim.nextId(120_000_000_000_000);
        this.o[`o/${id}`] = { kind: 'campaign', id, account: head, name: b.name, status: b.status };
        return { id };
      }
      if (method === 'POST' && edge === 'adsets') {
        const camp = this.o[`o/${b.campaign_id}`];
        if (!camp) throw bad('(#100) Invalid campaign_id');
        if (!b.promoted_object?.pixel_id || b.optimization_goal !== 'OFFSITE_CONVERSIONS') throw bad('(#100) promoted_object.pixel_id is required for OFFSITE_CONVERSIONS');
        const px = this.o[`px/${b.promoted_object.pixel_id}`];
        if (!px || !px.shared.includes(head.slice(4))) throw bad('(#100) The pixel is not shared with this ad account');
        const minor = Number(b.daily_budget);
        if (!(minor >= 100)) throw bad('(#1885272) Daily budget too low');
        const id = this.sim.nextId(120_000_000_000_000);
        this.o[`o/${id}`] = { kind: 'adset', id, account: head, name: b.name, parent: b.campaign_id, status: b.status };
        this.sim.addCampaign({ id, account: head, name: b.name, budgetMinor: minor, active: false });
        return { id };
      }
      if (method === 'POST' && edge === 'adcreatives') {
        const ld = b.object_story_spec?.link_data;
        if (!b.object_story_spec?.page_id || !ld?.link) throw bad('(#100) object_story_spec.page_id and link_data.link are required');
        const id = this.sim.nextId(120_000_000_000_000);
        this.o[`o/${id}`] = { kind: 'creative', id, account: head, name: b.name, disapproved: POLICY.test(`${ld.message ?? ''} ${ld.name ?? ''}`) };
        return { id };
      }
      if (method === 'POST' && edge === 'ads') {
        const set = this.o[`o/${b.adset_id}`];
        const cr = this.o[`o/${b.creative?.creative_id}`];
        if (!set || !cr) throw bad('(#100) Invalid adset_id or creative');
        const id = this.sim.nextId(120_000_000_000_000);
        this.o[`o/${id}`] = { kind: 'ad', id, account: head, name: b.name, parent: b.adset_id, status: b.status };
        if (cr.disapproved) this.sim.campaign(b.adset_id)!.review = 'DISAPPROVED';
        this.recompute(set.parent);
        return { id };
      }
      throw bad(`Stub: unsupported ${method} ${p}`);
    }
    // --- Object by id
    if (/^\d+$/.test(head)) {
      const x = this.o[`o/${head}`];
      if (!x) throw bad(`Unsupported request - Object with ID '${head}' does not exist`);
      if (method === 'POST' && !edge) {
        if (b.status) { x.status = b.status; this.recompute(x.kind === 'campaign' ? x.id : x.kind === 'adset' ? x.parent : this.o[`o/${x.parent}`].parent); }
        if (b.daily_budget !== undefined) {
          if (x.kind !== 'adset') throw bad('(#100) daily_budget is set on the ad set');
          this.sim.setBudget(x.id, Number(b.daily_budget));
        }
        return { success: true };
      }
      if (method === 'GET' && edge === 'insights') {
        const tr = b.time_range ?? {};
        const sets = x.kind === 'campaign' ? Object.values(this.o).filter((s: any) => s.kind === 'adset' && s.parent === x.id) as any[] : [x];
        const byDay = new Map<string, { s: number; i: number; k: number; cv: number; v: number }>();
        for (const s of sets) for (const r of this.sim.daily(s.id, tr.since, tr.until)) {
          const d = byDay.get(r.date) ?? { s: 0, i: 0, k: 0, cv: 0, v: 0 };
          d.s += r.spendMinor; d.i += r.impressions; d.k += r.clicks; d.cv += r.conversions; d.v += r.valueMinor;
          byDay.set(r.date, d);
        }
        return { data: [...byDay].sort().map(([date, d]) => ({ date_start: date, date_stop: date, spend: (d.s / 100).toFixed(2), impressions: String(d.i), clicks: String(d.k), actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: String(d.cv) }], action_values: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: (d.v / 100).toFixed(2) }] })) };
      }
      if (method === 'GET' && !edge) {
        const set = x.kind === 'campaign' ? (Object.values(this.o).find((s: any) => s.kind === 'adset' && s.parent === x.id) as any) : x;
        const sc = set ? this.sim.campaign(set.id) : null;
        const review = sc ? this.sim.reviewOf(sc) : 'PENDING';
        const eff = review === 'DISAPPROVED' ? 'DISAPPROVED' : x.status !== 'ACTIVE' ? 'PAUSED' : review === 'PENDING' ? 'IN_PROCESS' : 'ACTIVE';
        return { id: x.id, name: x.name, status: x.status, effective_status: eff };
      }
    }
    throw bad(`Stub: unsupported ${method} ${p}`);
  }
  /** Ad set delivers when campaign, ad set and at least one ad are ACTIVE. */
  private recompute(campaignId: string) {
    const camp = this.o[`o/${campaignId}`];
    for (const s of Object.values(this.o).filter((y: any) => y.kind === 'adset' && y.parent === campaignId) as any[]) {
      const ad = Object.values(this.o).some((a: any) => a.kind === 'ad' && a.parent === s.id && a.status === 'ACTIVE');
      this.sim.setActive(s.id, camp?.status === 'ACTIVE' && s.status === 'ACTIVE' && ad);
    }
  }
  record(pixelId: string, eventName: string, eventId: string, source: 'server' | 'browser', testEventCode: string | null) {
    const now = this.sim.now();
    const twin = this.sim.state.events.find((e) => e.pixelId === pixelId && e.eventName === eventName && e.eventId === eventId && now - e.receivedAt < 48 * 3600_000);
    this.sim.state.events.push({ pixelId, eventName, eventId, source, receivedAt: now, deduplicated: Boolean(twin), testEventCode });
    if (this.sim.state.events.length > 500) this.sim.state.events = this.sim.state.events.slice(-500);
    this.sim.save();
  }
  testEvents(pixelId: string) { return this.sim.state.events.filter((e) => e.pixelId === pixelId).slice(-50).reverse(); }
}
