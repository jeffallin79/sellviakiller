import { createHash } from 'node:crypto';

/**
 * External research data. Stub mode is deterministic sample data (seeded by the keyword) and is
 * labelled "sample data" everywhere it shows. Live adapters switch on with their key.
 */

const seed = (s: string) => createHash('sha256').update(s).digest();
/** Deterministic PRNG from a keyword (mulberry32) */
function rng(key: string) {
  let a = seed(key).readUInt32LE(0);
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------- Google Trends ----------------

export interface TrendsSource {
  readonly kind: 'stub' | 'serpapi';
  /** Weekly search interest for the last 12 months, 0–100 (Google's relative index). */
  weekly(keyword: string, geo: string): Promise<number[]>;
}

export class StubTrends implements TrendsSource {
  readonly kind = 'stub' as const;
  async weekly(keyword: string, geo: string) {
    const r = rng(`trends:${geo}:${keyword}`);
    const base = 15 + r() * 55;
    const slope = (r() - 0.45) * 1.1; // points per week
    const season = r() * 18;
    const phase = r() * Math.PI * 2;
    const pts: number[] = [];
    for (let w = 0; w < 52; w++) {
      const v = base + slope * (w - 26) + season * Math.sin((w / 52) * Math.PI * 2 + phase) + (r() - 0.5) * 8;
      pts.push(v);
    }
    const max = Math.max(...pts, 1);
    return pts.map((v) => Math.max(0, Math.round((v / max) * 100)));
  }
}

/**
 * SerpApi's Google Trends engine (Google's own Trends API is still an application-only alpha).
 * SERPAPI_API_KEY; one search per keyword, results cached by SerpApi for 1 h and by us for RESEARCH_TTL_HOURS.
 */
export class SerpApiTrends implements TrendsSource {
  readonly kind = 'serpapi' as const;
  constructor(private key = process.env.SERPAPI_API_KEY ?? '', private fetchImpl: typeof fetch = fetch) {}
  async weekly(keyword: string, geo: string) {
    const u = new URL('https://serpapi.com/search.json');
    u.searchParams.set('engine', 'google_trends');
    u.searchParams.set('q', keyword.slice(0, 100));
    u.searchParams.set('data_type', 'TIMESERIES');
    u.searchParams.set('date', 'today 12-m');
    if (geo) u.searchParams.set('geo', geo);
    u.searchParams.set('api_key', this.key);
    const res = await this.fetchImpl(u, { signal: AbortSignal.timeout(20_000) });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) throw new Error(`serpapi trends ${res.status}: ${String(body?.error ?? 'error').slice(0, 200)}`);
    const rows: any[] = body?.interest_over_time?.timeline_data ?? [];
    return rows.map((r) => Number(r?.values?.[0]?.extracted_value ?? 0)).filter((n) => Number.isFinite(n));
  }
}

// ---------------- Ad library (saturation) ----------------

export interface AdLibrarySource {
  readonly kind: 'stub' | 'meta';
  /** Where the count comes from, shown in the UI */
  readonly scope: string;
  /** Active ads matching the keyword (capped). */
  activeAds(keyword: string): Promise<number>;
}

export class StubAdLibrary implements AdLibrarySource {
  readonly kind = 'stub' as const;
  readonly scope = 'sample data';
  async activeAds(keyword: string) {
    const r = rng(`ads:${keyword}`);
    return Math.round(r() ** 2 * 320);
  }
}

/** EU + UK: Meta's Ad Library API only returns commercial ads that reached these countries. */
export const AD_LIBRARY_COUNTRIES = ['GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'IE', 'SE', 'PL', 'BE', 'AT', 'DK'];
const MAX_PAGES = 4;

/**
 * Meta Ad Library API (ads_archive). Needs META_AD_LIBRARY_TOKEN from a developer account that has
 * completed Meta's identity confirmation. Commercial ads are only searchable where they reached the
 * EU/UK (Digital Services Act), so this counts EU/UK-delivered ads: a proxy for saturation, not
 * the US total. Counts stop at MAX_PAGES × 250.
 */
export class MetaAdLibrary implements AdLibrarySource {
  readonly kind = 'meta' as const;
  readonly scope = 'Meta Ad Library, ads reaching the EU/UK';
  constructor(
    private token = process.env.META_AD_LIBRARY_TOKEN ?? '',
    private version = process.env.META_GRAPH_VERSION ?? 'v26.0',
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async activeAds(keyword: string) {
    let url: string | null = (() => {
      const u = new URL(`https://graph.facebook.com/${this.version}/ads_archive`);
      u.searchParams.set('search_terms', keyword.slice(0, 100));
      u.searchParams.set('ad_reached_countries', JSON.stringify(AD_LIBRARY_COUNTRIES));
      u.searchParams.set('ad_active_status', 'ACTIVE');
      u.searchParams.set('ad_type', 'ALL');
      u.searchParams.set('fields', 'id');
      u.searchParams.set('limit', '250');
      u.searchParams.set('access_token', this.token);
      return u.toString();
    })();
    let n = 0;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res: Response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`meta ad library ${res.status}: ${String(body?.error?.message ?? 'error').slice(0, 200)}`);
      n += Array.isArray(body?.data) ? body.data.length : 0;
      url = typeof body?.paging?.next === 'string' && body.paging.next.startsWith('https://graph.facebook.com/') ? body.paging.next : null;
    }
    return n;
  }
}

let trendsOverride: TrendsSource | null = null;
let adsOverride: AdLibrarySource | null = null;
export const getTrends = (): TrendsSource => trendsOverride ?? (process.env.SERPAPI_API_KEY ? new SerpApiTrends() : new StubTrends());
export const getAdLibrary = (): AdLibrarySource => adsOverride ?? (process.env.META_AD_LIBRARY_TOKEN ? new MetaAdLibrary() : new StubAdLibrary());
export function setResearchSourcesForTests(t: TrendsSource | null, a: AdLibrarySource | null) {
  trendsOverride = t;
  adsOverride = a;
}
