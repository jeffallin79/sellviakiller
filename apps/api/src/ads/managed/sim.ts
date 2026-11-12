import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Shared delivery simulator behind the managed-Boost stub clients (Meta managed, Google Ads,
 * TikTok). Each stub keeps the platform's own API shapes; this only answers "how much did each
 * campaign spend on each day", exactly, from:
 *   - active spans (ENABLE/PAUSE history), daily budget history,
 *   - review: nothing delivers before approval; disapproved never delivers,
 *   - the account's spend ceiling history (Meta spend_cap / Google account budget / TikTok
 *     prepaid balance). Once lifetime spend reaches the ceiling, delivery stops (like the real
 *     platforms), so tests can prove the platform can't spend fuel we can't collect.
 * Spend accrues at 75–100% of the daily budget (deterministic per campaign-day).
 */
export const DAY = 86_400_000;
export const unit = (s: string) => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) / 0xffffffff;
export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export type SimAccount = { id: string; name: string; currency: string; timezone: string; createdAt: number; status: 'ACTIVE' | 'DISABLED' | 'PENDING'; capHist: { at: number; minor: number | null }[]; extra?: Record<string, unknown> };
export type SimCampaign = {
  id: string; account: string; name: string; createdAt: number;
  budgetHist: { at: number; minor: number }[];
  spans: { from: number; to: number | null }[];
  review: 'PENDING' | 'APPROVED' | 'DISAPPROVED'; reviewAt: number;
  cpaMinor: number; aovMinor: number; extra?: Record<string, unknown>;
};
export type SimState = { seq: number; accounts: Record<string, SimAccount>; campaigns: Record<string, SimCampaign>; objects: Record<string, any>; events: any[] };

export class AdSim {
  state: SimState = { seq: 1000, accounts: {}, campaigns: {}, objects: {}, events: [] };
  now: () => number = () => Date.now();
  reviewMs = Number(process.env.STUB_ADS_REVIEW_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 30_000));

  constructor(private readonly file: string | null) {
    if (file && existsSync(file)) {
      try { this.state = { ...this.state, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* fresh */ }
    }
  }
  save() { if (this.file) writeFileSync(this.file, JSON.stringify(this.state)); }
  nextId(base = 0) { this.state.seq += 1; return String(base + this.state.seq); }

  addAccount(a: Omit<SimAccount, 'createdAt' | 'capHist' | 'status'> & { status?: SimAccount['status'] }) {
    const acct: SimAccount = { status: 'ACTIVE', ...a, createdAt: this.now(), capHist: [] };
    this.state.accounts[a.id] = acct;
    this.save();
    return acct;
  }
  account(id: string) { return this.state.accounts[id] ?? null; }
  addCampaign(c: { id: string; account: string; name: string; budgetMinor: number; active: boolean; disapprove?: boolean; extra?: Record<string, unknown> }) {
    const t = this.now();
    const camp: SimCampaign = {
      id: c.id, account: c.account, name: c.name, createdAt: t,
      budgetHist: [{ at: t, minor: c.budgetMinor }], spans: c.active ? [{ from: t, to: null }] : [],
      review: c.disapprove ? 'DISAPPROVED' : 'PENDING', reviewAt: t + this.reviewMs,
      cpaMinor: 2200 + Math.floor(unit(`cpa${c.id}`) * 1200), aovMinor: 4200 + Math.floor(unit(`aov${c.id}`) * 1500), extra: c.extra,
    };
    this.state.campaigns[c.id] = camp;
    this.save();
    return camp;
  }
  campaign(id: string) { return this.state.campaigns[id] ?? null; }
  reviewOf(c: SimCampaign, t = this.now()) {
    if (c.review === 'DISAPPROVED') return 'DISAPPROVED';
    return t >= c.reviewAt ? 'APPROVED' : 'PENDING';
  }
  setActive(id: string, on: boolean) {
    const c = this.state.campaigns[id];
    if (!c) return;
    const t = this.now();
    const open = c.spans.find((s) => s.to === null);
    if (on && !open) c.spans.push({ from: t, to: null });
    if (!on && open) open.to = t;
    this.save();
  }
  isActive(id: string) { return Boolean(this.state.campaigns[id]?.spans.some((s) => s.to === null)); }
  setBudget(id: string, minor: number) {
    const c = this.state.campaigns[id];
    if (!c) return;
    c.budgetHist.push({ at: this.now(), minor });
    this.save();
  }
  budget(id: string) { return this.state.campaigns[id]?.budgetHist.at(-1)?.minor ?? 0; }
  /** null = no ceiling */
  setCap(accountId: string, minor: number | null) {
    const a = this.state.accounts[accountId];
    if (!a) return;
    a.capHist.push({ at: this.now(), minor });
    this.save();
  }
  cap(accountId: string) { return this.state.accounts[accountId]?.capHist.at(-1)?.minor ?? null; }

  /** Exact spend (float minor units) per campaign per UTC day, honouring account ceilings. */
  private integrate(accountId: string, until = this.now()) {
    const a = this.state.accounts[accountId];
    const camps = Object.values(this.state.campaigns).filter((c) => c.account === accountId);
    const out = new Map<string, Map<string, number>>();
    if (!a || !camps.length) return { byCampaign: out, lifetime: 0 };
    const start = Math.min(...camps.map((c) => c.createdAt));
    const cuts = new Set<number>([start, until]);
    for (const c of camps) {
      cuts.add(c.reviewAt);
      for (const s of c.spans) { cuts.add(s.from); if (s.to !== null) cuts.add(s.to); }
      for (const b of c.budgetHist) cuts.add(b.at);
    }
    for (const h of a.capHist) cuts.add(h.at);
    for (let d = Date.parse(`${utcDay(start)}T00:00:00Z`) + DAY; d < until; d += DAY) cuts.add(d);
    const times = [...cuts].filter((t) => t >= start && t <= until).sort((x, y) => x - y);
    const at = <T extends { at: number }>(hist: T[], t: number) => { let v: T | undefined; for (const h of hist) if (h.at <= t) v = h; return v; };
    let lifetime = 0;
    for (let i = 0; i < times.length - 1; i++) {
      const t0 = times[i];
      const t1 = times[i + 1];
      if (t1 <= t0) continue;
      const day = utcDay(t0);
      const rates: [SimCampaign, number][] = [];
      for (const c of camps) {
        if (this.reviewOf(c, t0) !== 'APPROVED') continue;
        if (!c.spans.some((s) => s.from <= t0 && (s.to === null || s.to >= t1))) continue;
        const b = at(c.budgetHist, t0)?.minor ?? 0;
        rates.push([c, (b * (0.75 + 0.25 * unit(`${c.id}:${day}`))) / DAY]);
      }
      const total = rates.reduce((n, [, r]) => n + r, 0);
      if (!total) continue;
      let dt = t1 - t0;
      const capH = at(a.capHist, t0);
      if (capH && capH.minor !== null) dt = Math.max(0, Math.min(dt, (capH.minor - lifetime) / total));
      for (const [c, r] of rates) {
        const m = out.get(c.id) ?? new Map<string, number>();
        m.set(day, (m.get(day) ?? 0) + r * dt);
        out.set(c.id, m);
      }
      lifetime += total * dt;
    }
    return { byCampaign: out, lifetime };
  }

  /** Daily rows for one campaign (whole minor units; never sums above the ceiling). */
  daily(campaignId: string, since: string, until: string) {
    const c = this.state.campaigns[campaignId];
    if (!c) return [];
    const m = this.integrate(c.account).byCampaign.get(campaignId) ?? new Map();
    const rows: { date: string; spendMinor: number; impressions: number; clicks: number; conversions: number; valueMinor: number }[] = [];
    for (const [date, v] of [...m.entries()].sort()) {
      if (date < since || date > until) continue;
      const f = Number(c.extra?.revise ?? 1);
      const spendMinor = Math.floor(v * (date < utcDay(this.now()) ? f : 1));
      if (spendMinor <= 0) continue;
      const impressions = Math.floor((spendMinor / (900 + unit(`cpm${campaignId}`) * 900)) * 1000);
      const clicks = Math.floor(impressions * (0.009 + 0.01 * unit(`ctr${campaignId}${date}`)));
      const conversions = Math.floor(spendMinor / c.cpaMinor);
      rows.push({ date, spendMinor, impressions, clicks, conversions, valueMinor: conversions * c.aovMinor });
    }
    return rows;
  }
  /** Lifetime account spend in whole minor units (what the platform bills us). */
  accountSpend(accountId: string) {
    let n = 0;
    for (const m of this.integrate(accountId).byCampaign.values()) for (const v of m.values()) n += Math.floor(v);
    return n;
  }
  /** Test hook: platform revises a past day (e.g. invalid-click credit, late conversions). */
  revise(campaignId: string, factor: number) {
    const c = this.state.campaigns[campaignId];
    if (c) { c.extra = { ...(c.extra ?? {}), revise: factor }; this.save(); }
  }
}

/** Optional per-call latency for the stubs (dev realism; 0 in tests). */
export const latency = () => {
  const ms = Number(process.env.STUB_ADS_LATENCY_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 120));
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
};
