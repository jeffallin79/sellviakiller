import { z } from 'zod';

/**
 * Margin calculator (blueprint slice 5): per-order unit economics including ad cost.
 * Pure and shared, so the admin's live calculator and the API's ProductScore agree to the cent.
 */
export const MarginInputSchema = z.object({
  priceCents: z.number().int().min(0).max(10_000_000),
  /** Supplier product cost per unit */
  costCents: z.number().int().min(0).max(10_000_000),
  units: z.number().int().min(1).max(99).default(1),
  /** What the supplier charges you to ship the order */
  supplierShippingCents: z.number().int().min(0).max(1_000_000).default(0),
  /** What the shopper pays for shipping on this order */
  shippingChargedCents: z.number().int().min(0).max(1_000_000).default(0),
  /** Card processing: Stripe US standard 2.9% + 30¢ */
  paymentPct: z.number().min(0).max(20).default(2.9),
  paymentFixedCents: z.number().int().min(0).max(1000).default(30),
  /** StoreForge commission on orders (PLATFORM_FEE_BPS, 0 today) */
  platformFeeBps: z.number().int().min(0).max(5000).default(0),
  /** Ad spend needed to win one order (CPA) */
  adCostPerOrderCents: z.number().int().min(0).max(1_000_000).default(0),
  /** Fee on ad spend: Boost managed ADS_FEE_PCT (15) or connect-your-own ADS_OWNED_FEE_PCT (0) */
  adFeePct: z.number().min(0).max(100).default(15),
  /** Share of revenue set aside for refunds / chargebacks */
  refundRatePct: z.number().min(0).max(100).default(3),
});
export type MarginInput = z.input<typeof MarginInputSchema>;

export type MarginResult = {
  revenueCents: number;
  cogsCents: number;
  paymentFeesCents: number;
  platformFeeCents: number;
  adSpendCents: number;
  adFeeCents: number;
  refundReserveCents: number;
  /** Profit before any ad cost */
  profitBeforeAdsCents: number;
  profitCents: number;
  /** profit / revenue, % (can be negative) */
  marginPct: number;
  /** The most you can spend on ads per order (fee included) and still break even */
  breakEvenCpaCents: number;
  /** Revenue ÷ break-even ad spend. null when the product loses money before ads */
  breakEvenRoas: number | null;
  /** ROAS at the CPA you entered (null with no ad cost) */
  roas: number | null;
};

export function marginCalc(raw: MarginInput): MarginResult {
  const i = MarginInputSchema.parse(raw);
  const revenue = i.priceCents * i.units + i.shippingChargedCents;
  const cogs = i.costCents * i.units + i.supplierShippingCents;
  const payment = revenue > 0 ? Math.round((revenue * i.paymentPct) / 100) + i.paymentFixedCents : 0;
  const platform = Math.round((revenue * i.platformFeeBps) / 10_000);
  const refunds = Math.round((revenue * i.refundRatePct) / 100);
  const before = revenue - cogs - payment - platform - refunds;
  const adSpend = i.adCostPerOrderCents;
  const adFee = Math.round((adSpend * i.adFeePct) / 100);
  const profit = before - adSpend - adFee;
  const breakEvenCpa = before > 0 ? Math.floor(before / (1 + i.adFeePct / 100)) : 0;
  return {
    revenueCents: revenue,
    cogsCents: cogs,
    paymentFeesCents: payment,
    platformFeeCents: platform,
    adSpendCents: adSpend,
    adFeeCents: adFee,
    refundReserveCents: refunds,
    profitBeforeAdsCents: before,
    profitCents: profit,
    marginPct: revenue > 0 ? round1((profit / revenue) * 100) : 0,
    breakEvenCpaCents: breakEvenCpa,
    breakEvenRoas: breakEvenCpa > 0 ? round2(revenue / breakEvenCpa) : null,
    roas: adSpend > 0 ? round2(revenue / adSpend) : null,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** Score weights (documented in the admin "How scores work" panel). */
export const SCORE_WEIGHTS = { trend: 0.35, margin: 0.3, room: 0.2, eta: 0.15 } as const;

/** Search interest series (weekly, 0–100) → level + 12-week momentum. */
export function searchSignal(series: number[]) {
  if (!series.length) return { index: null as number | null, change: null as number | null, score: 0 };
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const recent = series.slice(-4);
  const last12 = series.slice(-12);
  const prior12 = series.slice(-24, -12);
  const index = Math.round(avg(recent));
  const change = prior12.length ? round1(avg(last12) - avg(prior12)) : 0;
  // Level counts 60%, momentum 40% (+25 points over 12 weeks = full marks, −25 = none)
  const momentum = clamp(50 + change * 2);
  return { index, change, score: Math.round(0.6 * index + 0.4 * momentum) };
}

/** Paid units/day → 0–100 on a log scale (1/day ≈ 50, 10/day ≈ 100). */
export const velocityScore = (unitsPerDay: number) => Math.round(clamp(50 * Math.log10(1 + unitsPerDay * 9)));
/** Trend 0–100: Google Trends signal 65%, StoreForge order velocity 35%. */
export const trendScore = (searchScore: number, unitsPerDay: number) => Math.round(0.65 * searchScore + 0.35 * velocityScore(unitsPerDay));
/** Margin after ads: 0% or worse → 0, 35%+ → 100. */
export const marginScore = (marginPct: number) => Math.round(clamp((marginPct / 35) * 100));
/** Active ads → saturation 0–100 (0 ads = 0, ~20 = 50, 300+ ≈ 100). */
export const saturationScore = (adCount: number | null) => (adCount == null ? 50 : Math.round(clamp(25 * Math.log2(1 + adCount / 1.5) / 2.07)));
/** Slowest delivery ≤ 7 days → 100, ≥ 30 days → 0. */
export const etaScore = (etaDaysMax: number) => Math.round(clamp(((30 - etaDaysMax) / 23) * 100));

export function compositeScore(p: { trend: number; margin: number; saturation: number; eta: number }) {
  const w = SCORE_WEIGHTS;
  return Math.round(w.trend * p.trend + w.margin * p.margin + w.room * (100 - p.saturation) + w.eta * p.eta);
}

/** Research keyword from a product title: drop filler and sizes, keep up to 4 words. */
export function researchKeyword(title: string) {
  const stop = new Set(['the', 'a', 'an', 'and', 'for', 'with', 'of', 'in', 'to', 'set', 'pack', 'pcs', 'new', 'premium', 'mini', 'pro']);
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !stop.has(w) && !/^\d+(ml|oz|cm|mm|in|pc|pcs|x)?$/.test(w));
  return words.slice(0, 4).join(' ') || title.toLowerCase().slice(0, 40);
}

// ---------------- Cart capture (abandoned-cart recovery) ----------------

/** Shown next to the opt-in checkbox and stored with the cart, word for word. */
export const CART_CONSENT_TEXT =
  "Email me a reminder about this bag if I don't finish checking out (at most 2 emails, unsubscribe any time).";

export const CartTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

export const CartCaptureSchema = z.object({
  storeSlug: z.string().min(1).max(100),
  token: CartTokenSchema,
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  name: z.string().trim().max(120).optional(),
  /** The shopper ticked the reminder box. false withdraws it and scrubs the stored email. */
  consent: z.boolean(),
  lines: z.array(z.object({ storeProductId: z.string().min(1).max(64), quantity: z.number().int().min(1).max(99) })).max(50),
});
export type CartCaptureInput = z.infer<typeof CartCaptureSchema>;
