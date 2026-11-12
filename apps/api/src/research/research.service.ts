import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { prisma, Prisma } from '@storeforge/db';
import {
  compositeScore, etaScore, marginCalc, marginScore, researchKeyword, saturationScore, searchSignal, trendScore, velocityScore,
  SCORE_WEIGHTS,
} from '@storeforge/shared';
import { feePct } from '../ads/ads.config';
import { PolicyService } from '../ads/managed/policy.service';
import { getAdLibrary, getTrends } from './sources';
import { cleanText, getLlm } from './llm';

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : d;
};
/** Default assumptions behind every stored score (all editable in the admin calculator). */
export const researchDefaults = () => ({
  geo: process.env.RESEARCH_GEO || 'US',
  /** Estimated ad cost per order as % of price until a product has real Boost data */
  cpaPct: num(process.env.RESEARCH_CPA_PCT, 30),
  supplierShippingCents: num(process.env.RESEARCH_SUPPLIER_SHIPPING_CENTS, 350),
  refundRatePct: 3,
  ttlMs: num(process.env.RESEARCH_TTL_HOURS, 24) * 3_600_000,
});

const PAID = ['PAID', 'AWAITING_MERCHANT_APPROVAL', 'FULFILLMENT_SUBMITTED', 'SHIPPED', 'DELIVERED'];
type Angle = { headline: string; primaryText: string; policy: 'pass' | 'warn'; notes: string[] };

/**
 * Product research (blueprint slice 5): ProductScore = trend (Google Trends + StoreForge order
 * velocity), margin after ads, saturation (ad library), shipping speed; plus an insight and ad
 * angle drafts from the LLM (template in stub mode). Idempotent upsert per product.
 */
@Injectable()
export class ResearchService {
  private readonly logger = new Logger(ResearchService.name);
  private readonly policy = new PolicyService();

  sources() {
    const t = getTrends();
    const a = getAdLibrary();
    const l = getLlm();
    return { trends: t.kind, adLibrary: a.kind, adLibraryScope: a.scope, llm: l.kind, llmModel: l.model };
  }

  private async velocity(productIds: string[], now: Date) {
    if (!productIds.length) return new Map<string, number>();
    const rows = await prisma.$queryRaw<{ productId: string; units: bigint }[]>`
      SELECT sp."productId" AS "productId", COALESCE(SUM(ol.quantity), 0)::bigint AS units
      FROM "OrderLine" ol
      JOIN "Order" o ON o.id = ol."orderId"
      JOIN "StoreProduct" sp ON sp.id = ol."storeProductId"
      WHERE sp."productId" IN (${Prisma.join(productIds)})
        AND o.status::text IN (${Prisma.join(PAID)})
        AND o."createdAt" >= ${new Date(now.getTime() - 14 * 86_400_000)}
      GROUP BY sp."productId"`;
    return new Map(rows.map((r) => [r.productId, Number(r.units) / 14]));
  }

  /** Score one product now (force) or only when stale. */
  async score(productId: string, opts: { force?: boolean; now?: Date } = {}) {
    const now = opts.now ?? new Date();
    const d = researchDefaults();
    const p = await prisma.product.findUnique({ where: { id: productId }, include: { score: true } });
    if (!p) throw new NotFoundException('Product not found');
    if (!opts.force && p.score && now.getTime() - p.score.computedAt.getTime() < d.ttlMs) return p.score;

    const keyword = researchKeyword(p.title);
    const trends = getTrends();
    const ads = getAdLibrary();
    let series: number[] = [];
    let trendsError: string | null = null;
    try { series = await trends.weekly(keyword, d.geo); } catch (e: any) { trendsError = String(e?.message ?? e).slice(0, 200); }
    let adCount: number | null = null;
    let adsError: string | null = null;
    try { adCount = await ads.activeAds(keyword); } catch (e: any) { adsError = String(e?.message ?? e).slice(0, 200); }
    const unitsPerDay = (await this.velocity([p.id], now)).get(p.id) ?? 0;

    const search = searchSignal(series);
    const shippingCharged = p.priceCents >= 5000 ? 0 : 499;
    const assumptions = {
      priceCents: p.priceCents,
      costCents: p.costCents,
      supplierShippingCents: d.supplierShippingCents,
      shippingChargedCents: shippingCharged,
      platformFeeBps: num(process.env.PLATFORM_FEE_BPS, 0),
      adCostPerOrderCents: Math.round((p.priceCents * d.cpaPct) / 100),
      adFeePct: feePct('MANAGED'),
      refundRatePct: d.refundRatePct,
    };
    const m = marginCalc(assumptions);
    const parts = {
      trend: trendScore(search.score, unitsPerDay),
      margin: marginScore(m.marginPct),
      saturation: saturationScore(adCount),
      eta: etaScore(p.etaDaysMax),
    };
    const score = compositeScore(parts);
    const sourceKinds = { trends: trends.kind, adLibrary: ads.kind, adLibraryScope: ads.scope, llm: getLlm().kind };
    const facts = { title: p.title, category: p.category, keyword, score, parts, search, adCount, unitsPerDay, margin: m, eta: { min: p.etaDaysMin, max: p.etaDaysMax }, sample: trends.kind === 'stub' || ads.kind === 'stub' };
    const drafted = await this.draft(facts);

    const data = {
      score,
      trendScore: parts.trend,
      marginScore: parts.margin,
      saturationScore: parts.saturation,
      etaScore: parts.eta,
      keyword,
      orderVelocity: Math.round(unitsPerDay * 100) / 100,
      searchIndex: search.index,
      searchChange: search.change,
      adCount,
      profitCents: m.profitCents,
      marginPct: m.marginPct,
      breakEvenRoas: m.breakEvenRoas,
      sources: { ...sourceKinds, llmModel: drafted.model, errors: { trends: trendsError, adLibrary: adsError, llm: drafted.error } } as Prisma.InputJsonValue,
      inputs: { series, assumptions, velocityScore: velocityScore(unitsPerDay), searchScore: search.score, weights: SCORE_WEIGHTS, geo: d.geo, cpaPct: d.cpaPct } as Prisma.InputJsonValue,
      insight: drafted.insight,
      angles: drafted.angles as unknown as Prisma.InputJsonValue,
      computedAt: now,
    };
    return prisma.productScore.upsert({ where: { productId: p.id }, create: { productId: p.id, ...data }, update: data });
  }

  /** Score up to `limit` products that have no score yet or a stale one. */
  async refreshBatch(limit = 50, opts: { force?: boolean; productIds?: string[] } = {}) {
    const d = researchDefaults();
    const stale = new Date(Date.now() - d.ttlMs);
    const take = Math.max(1, Math.min(limit, 100));
    const products = await prisma.product.findMany({
      where: {
        active: true,
        ...(opts.productIds ? { id: { in: opts.productIds.slice(0, 100) } } : {}),
        ...(opts.force ? {} : { OR: [{ score: null }, { score: { computedAt: { lt: stale } } }] }),
      },
      orderBy: { createdAt: 'asc' },
      take,
      select: { id: true },
    });
    let ok = 0;
    const failed: string[] = [];
    // A few at a time: live sources are rate-limited and billed per call
    for (let i = 0; i < products.length; i += 4) {
      const chunk = products.slice(i, i + 4);
      const rs = await Promise.allSettled(chunk.map((p) => this.score(p.id, { force: true })));
      rs.forEach((r, j) => (r.status === 'fulfilled' ? ok++ : failed.push(chunk[j].id)));
    }
    const remaining = await prisma.product.count({ where: { active: true, OR: [{ score: null }, { score: { computedAt: { lt: stale } } }] } });
    return { scored: ok, failed, remaining };
  }

  async list(q: { q?: string; category?: string; sort?: string; take?: number; skip?: number }) {
    const order: Record<string, Prisma.ProductScoreOrderByWithRelationInput> = {
      score: { score: 'desc' }, trend: { trendScore: 'desc' }, margin: { marginPct: 'desc' }, room: { saturationScore: 'asc' }, eta: { etaScore: 'desc' },
    };
    const where: Prisma.ProductScoreWhereInput = {
      product: {
        active: true,
        ...(q.category ? { category: q.category } : {}),
        ...(q.q ? { title: { contains: q.q.slice(0, 100), mode: 'insensitive' as const } } : {}),
      },
    };
    const [items, total, unscored, categories] = await Promise.all([
      prisma.productScore.findMany({
        where,
        orderBy: [order[q.sort ?? 'score'] ?? order.score, { productId: 'asc' }],
        take: Math.min(q.take ?? 30, 100),
        skip: Math.max(0, q.skip ?? 0),
        include: { product: { select: { id: true, title: true, sku: true, category: true, imageUrl: true, priceCents: true, costCents: true, etaDaysMin: true, etaDaysMax: true, sourcingLabel: true } } },
      }),
      prisma.productScore.count({ where }),
      prisma.product.count({ where: { active: true, score: null } }),
      prisma.product.findMany({ where: { active: true, category: { not: null } }, distinct: ['category'], select: { category: true }, orderBy: { category: 'asc' } }),
    ]);
    return {
      sources: this.sources(),
      defaults: researchDefaults(),
      total,
      unscored,
      categories: categories.map((c) => c.category),
      items: items.map((s) => ({ ...s, inputs: undefined, series: ((s.inputs as any)?.series ?? []) as number[] })),
    };
  }

  async get(productId: string) {
    const s = await prisma.productScore.findUnique({ where: { productId }, include: { product: true } });
    if (!s) {
      const p = await prisma.product.findUnique({ where: { id: productId } });
      if (!p) throw new NotFoundException('Product not found');
      return { product: p, score: null, sources: this.sources(), defaults: researchDefaults() };
    }
    const { product, ...score } = s;
    return { product, score, sources: this.sources(), defaults: researchDefaults(), feePct: { managed: feePct('MANAGED'), owned: feePct('OWNED') } };
  }

  // ---------------- copy drafts ----------------

  private template(f: any) {
    const s = f.search;
    const trendWord = s.change == null ? 'no search data' : s.change > 5 ? 'rising' : s.change < -5 ? 'cooling' : 'steady';
    const sat = f.parts.saturation >= 67 ? 'crowded' : f.parts.saturation >= 34 ? 'moderately busy' : 'quiet';
    const marginLine = f.margin.profitCents > 0
      ? `keeps about $${(f.margin.profitCents / 100).toFixed(2)} an order after an estimated $${(f.margin.adSpendCents / 100).toFixed(2)} of ads`
      : `loses money at an estimated $${(f.margin.adSpendCents / 100).toFixed(2)} of ads per order, so it needs cheaper ads or a higher price`;
    const insight = `${f.sample ? 'Sample data. ' : ''}Search interest for "${f.keyword}" is ${trendWord}${s.index != null ? ` (${s.index}/100 lately)` : ''}, the ad space looks ${sat}${f.adCount != null ? ` (${f.adCount} active ads)` : ''}, and it ${marginLine}. Arrives in ${f.eta.min}–${f.eta.max} days.`;
    const t = String(f.title);
    const angles = [
      { headline: `${t}, delivered`.slice(0, 40), primaryText: `${t}. Arrives in ${f.eta.min}–${f.eta.max} days, and the price you see is the price you pay.`.slice(0, 125) },
      { headline: `Made for everyday use`.slice(0, 40), primaryText: `Meet the ${t.toLowerCase()}: simple, useful and shipped to your door in ${f.eta.min}–${f.eta.max} days.`.slice(0, 125) },
      { headline: `A small upgrade you'll use`.slice(0, 40), primaryText: `The ${t.toLowerCase()} does one job well. See the details and delivery time before you buy.`.slice(0, 125) },
    ];
    return { insight, angles };
  }

  private async draft(f: any): Promise<{ insight: string; angles: Angle[]; model: string; error: string | null }> {
    const base = this.template(f);
    const llm = getLlm();
    let insight = base.insight;
    let angles: { headline: string; primaryText: string }[] = base.angles;
    let error: string | null = null;
    if (llm.kind !== 'stub') {
      try {
        const raw = await llm.complete({
          system:
            'You help a small online shop decide what to sell and draft honest ad copy. Use only the numbers given. ' +
            'No invented reviews, no medical or income claims, no fake urgency or scarcity, no discounts that were not offered, no ALL CAPS, at most one exclamation mark. ' +
            'Reply with JSON: {"insight": string (max 300 chars, plain English, mention the weakest factor), "angles": [{"headline": string (max 40 chars), "primaryText": string (max 125 chars)}] (exactly 3)}.',
          user: JSON.stringify({
            product: f.title, category: f.category, keyword: f.keyword, score: f.score, parts: f.parts,
            searchIndex: f.search.index, searchChange12w: f.search.change, activeAds: f.adCount, unitsPerDay: f.unitsPerDay,
            priceUsd: f.margin.revenueCents / 100, profitPerOrderUsd: f.margin.profitCents / 100, marginPct: f.margin.marginPct,
            breakEvenRoas: f.margin.breakEvenRoas, deliveryDays: `${f.eta.min}-${f.eta.max}`, sampleData: f.sample,
          }),
          maxTokens: 700,
        });
        const j = JSON.parse(raw);
        const i = cleanText(j?.insight, 300);
        const a = Array.isArray(j?.angles) ? j.angles.slice(0, 3).map((x: any) => ({ headline: cleanText(x?.headline, 40), primaryText: cleanText(x?.primaryText, 125) })).filter((x: any) => x.headline && x.primaryText) : [];
        if (i) insight = (f.sample && !/^sample data/i.test(i) ? 'Sample data. ' : '') + i;
        if (a.length) angles = a;
      } catch (e: any) {
        error = String(e?.message ?? e).slice(0, 200);
        this.logger.warn(`llm draft fell back to template: ${error}`);
      }
    }
    // Policy scan: blocked drafts are dropped, warnings shown next to the draft
    const checked: Angle[] = [];
    for (const a of angles) {
      const r = this.policy.scan({
        title: f.title, category: f.category,
        texts: [{ field: 'headline', text: a.headline }, { field: 'primaryText', text: a.primaryText }],
        landing: { priceCents: f.margin.revenueCents, etaDaysMin: f.eta.min, etaDaysMax: f.eta.max, https: true },
      });
      if (r.result === 'block') continue;
      checked.push({ ...a, policy: r.result === 'warn' ? 'warn' : 'pass', notes: r.findings.map((x) => x.message) });
    }
    return { insight, angles: checked.length ? checked : base.angles.map((a) => ({ ...a, policy: 'pass' as const, notes: [] })), model: llm.model, error };
  }
}
