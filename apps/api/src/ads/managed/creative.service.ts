import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { isBlockedAddress } from '../../domains/tls';
import { apiPublicUrl } from '../ads.config';

export type Variant = { headline: string; headlines: string[]; longHeadline: string; body: string; descriptions: string[]; angle: string };
export type Crop = { ratio: string; token: string; w: number; h: number; url: string };
export const CROPS = [
  { ratio: '1:1', token: '1x1', w: 1200, h: 1200 },
  { ratio: '4:5', token: '4x5', w: 960, h: 1200 },
  { ratio: '9:16', token: '9x16', w: 1080, h: 1920 },
  { ratio: '1.91:1', token: '191x100', w: 1200, h: 628 },
] as const;

/** Copy writer behind an interface so an LLM writer can replace the templates later. */
export interface CopyWriter { variants(p: { title: string; description: string; priceCents: number; currency: string; etaDaysMin: number; etaDaysMax: number; storeName: string; category: string | null }): Variant[] }

const money = (c: number, cur: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(c / 100);
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const firstSentence = (s: string) => (s.split(/(?<=[.!?])\s/)[0] ?? s).trim();

export class TemplateCopyWriter implements CopyWriter {
  variants(p: Parameters<CopyWriter['variants']>[0]): Variant[] {
    const price = money(p.priceCents, p.currency);
    const eta = `${p.etaDaysMin}–${p.etaDaysMax} days`;
    const t = cut(p.title, 30);
    const desc = cut(firstSentence(p.description || p.title), 90);
    const common = [t, `${cut(p.title, 20)} · ${price}`, `Shop ${cut(p.storeName, 25)}`, `Arrives in ${eta}`, 'Secure card checkout'];
    const mk = (angle: string, headline: string, body: string, long: string): Variant => ({
      angle, headline: cut(headline, 40), body: cut(body, 125),
      headlines: [cut(headline, 30), ...common.filter((h) => h !== headline)].slice(0, 5).map((h) => cut(h, 30)),
      longHeadline: cut(long, 90), descriptions: [cut(`${desc}`, 60), cut(`${price}. Delivery in ${eta}, shown before you pay.`, 90), cut(`From ${p.storeName}. Small-batch, picked by hand.`, 90)],
    });
    return [
      mk('product', p.title, `${desc} ${price}, delivered in ${eta}.`, `${p.title}, ${price}`),
      mk('price', `${cut(p.title, 24)} for ${price}`, `${cut(p.title, 60)} for ${price}. Delivery time shown before checkout: ${eta}.`, `${p.title} for ${price}, delivered in ${eta}`),
      mk('delivery', `Know when it arrives`, `No guessing: ${cut(p.title, 50)} arrives in ${eta}. ${price}.`, `${p.title}: delivery in ${eta}, shown before you pay`),
      mk('gift', `A gift that stands out`, `Looking for something different? ${cut(p.title, 50)}, ${price}. Arrives in ${eta}.`, `${p.title}: a gift that stands out`),
    ];
  }
}

/**
 * Creative crops for every placement (1:1 feed, 4:5 Meta/IG, 9:16 TikTok/Reels/Stories,
 * 1.91:1 Google/Meta landscape). Rendered by sharp from the product image on a brand background,
 * no text overlay (Google product + PMax policy friendly). Served at a public URL because the
 * platforms fetch images themselves.
 */
export class CreativeService {
  private cache = new Map<string, Buffer>();
  constructor(readonly writer: CopyWriter = new TemplateCopyWriter()) {}

  cropsFor(storeProductId: string, version = 1): Crop[] {
    return CROPS.map((c) => ({ ratio: c.ratio, token: c.token, w: c.w, h: c.h, url: `${apiPublicUrl()}/api/managed/render/${storeProductId}/${c.token}.png?v=${version}` }));
  }

  /** Bundled /catalog/*.svg from the storefront, or an https image (SSRF-guarded, ≤5 MB). */
  async source(imageUrl: string | null): Promise<Buffer | null> {
    if (!imageUrl) return null;
    const local = /^\/catalog\/([\w-]+\.(svg|png|jpe?g|webp))$/i.exec(imageUrl);
    if (local) {
      const dir = process.env.CATALOG_ASSET_DIR ?? resolve(process.cwd(), '../storefront/public/catalog');
      return readFile(resolve(dir, local[1])).catch(() => null);
    }
    let u: URL;
    try { u = new URL(imageUrl); } catch { return null; }
    if (u.protocol !== 'https:') return null;
    const { address } = await lookup(u.hostname);
    if (isBlockedAddress(address)) return null;
    const r = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!r?.ok) return null;
    const len = Number(r.headers.get('content-length') ?? 0);
    if (len > 5_000_000) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 5_000_000 ? null : buf;
  }

  async render(key: string, imageUrl: string | null, token: string, bg = '#f6efe3'): Promise<Buffer | null> {
    const spec = CROPS.find((c) => c.token === token);
    if (!spec) return null;
    const ck = `${key}:${token}:${imageUrl}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;
    const src = await this.source(imageUrl);
    const inner = Math.round(Math.min(spec.w, spec.h) * 0.78);
    const art = src ? await sharp(src, { density: 300 }).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer() : null;
    let img = sharp({ create: { width: spec.w, height: spec.h, channels: 4, background: bg } });
    if (art) img = img.composite([{ input: art, gravity: 'center' }]);
    const out = await img.png({ compressionLevel: 8 }).toBuffer();
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(ck, out);
    return out;
  }
}
