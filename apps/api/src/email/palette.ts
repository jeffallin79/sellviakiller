import { readFileSync } from 'node:fs';

/**
 * Email clients can't use CSS variables, so emails inline hex colours. They are read from
 * packages/ui/tokens.css (light theme) — the single source of truth — never typed by hand.
 */
export type EmailPalette = Record<
  'canvas' | 'surface' | 'surface2' | 'ink' | 'muted' | 'line' | 'brand' | 'onBrand' | 'money' | 'onMoney' | 'moneyInk' | 'alt' | 'band' | 'onBand' | 'bandMuted' | 'bandBrand' | 'ok' | 'bad',
  string
>;

const toHex = (triplet: string) =>
  '#' + triplet.trim().split(/\s+/).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();

export function parseRootTokens(css: string): Record<string, string> {
  const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
  const raw: Record<string, string> = {};
  for (const m of root.matchAll(/--sf-([a-z0-9-]+):\s*([^;]+);/g)) raw[m[1]] = m[2].replace(/\/\*.*?\*\//g, '').trim();
  const out: Record<string, string> = {};
  const resolve = (name: string, depth = 0): string | null => {
    const v = raw[name];
    if (v == null || depth > 8) return null;
    const ref = /^var\(--sf-([a-z0-9-]+)\)$/.exec(v);
    if (ref) return resolve(ref[1], depth + 1);
    return /^\d+\s+\d+\s+\d+$/.test(v) ? toHex(v) : null;
  };
  for (const k of Object.keys(raw)) {
    const hex = resolve(k);
    if (hex) out[k] = hex;
  }
  return out;
}

let cached: EmailPalette | null = null;
export function emailPalette(): EmailPalette {
  if (cached) return cached;
  const css = readFileSync(require.resolve('@storeforge/ui/tokens.css'), 'utf8');
  const t = parseRootTokens(css);
  const pick = (k: string) => {
    if (!t[k]) throw new Error(`tokens.css is missing --sf-${k}`);
    return t[k];
  };
  cached = {
    canvas: pick('canvas'), surface: pick('surface'), surface2: pick('surface-2'), ink: pick('ink'), muted: pick('muted'),
    line: pick('line'), brand: pick('brand'), onBrand: pick('on-brand'), money: pick('money'), onMoney: pick('on-money'),
    moneyInk: pick('money-ink'), alt: pick('alt'), band: pick('band'), onBand: pick('on-band'), bandMuted: pick('band-muted'),
    bandBrand: pick('band-brand'), ok: pick('ok-ink'), bad: pick('bad-ink'),
  };
  return cached;
}
