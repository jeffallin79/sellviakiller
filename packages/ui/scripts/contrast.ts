import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Rgb = [number, number, number];
const root = join(__dirname, '..');

function block(css: string, selector: RegExp): Record<string, string> {
  const m = css.match(selector);
  if (!m) throw new Error(`selector not found: ${selector}`);
  const out: Record<string, string> = {};
  for (const d of m[1].matchAll(/--(sf-[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].replace(/\/\*.*?\*\//g, '').trim();
  return out;
}

/** Resolves every --sf-* colour token for a theme to an RGB triplet. */
export function loadTheme(theme: 'light' | 'dark'): Record<string, Rgb> {
  const css = readFileSync(join(root, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const vars = { ...block(css, /:root\s*{([\s\S]*?)\n}/), ...(theme === 'dark' ? block(css, /\[data-theme='dark'\]\s*{([\s\S]*?)\n}/) : {}) };
  const resolve = (name: string, depth = 0): Rgb | null => {
    const raw = vars[name];
    if (!raw || depth > 10) return null;
    const ref = raw.match(/^var\(--(sf-[\w-]+)\)$/);
    if (ref) return resolve(ref[1], depth + 1);
    const nums = raw.split(/\s+/).map(Number);
    return nums.length === 3 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? (nums as Rgb) : null;
  };
  const out: Record<string, Rgb> = {};
  for (const k of Object.keys(vars)) {
    const v = resolve(k);
    if (v) out[k.replace(/^sf-/, '')] = v;
  }
  return out;
}

const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function contrast(a: Rgb, b: Rgb) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
export const hex = ([r, g, b]: Rgb) => '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();

/** Every text-on-background pairing the apps use (AA normal text = 4.5). */
export const TEXT_PAIRS: [string, string][] = [
  ['ink', 'canvas'], ['ink', 'surface'], ['ink', 'surface-2'],
  ['muted', 'canvas'], ['muted', 'surface'], ['muted', 'surface-2'],
  ['brand', 'canvas'], ['brand', 'surface'], ['on-brand', 'brand'],
  ['on-money', 'money'], ['money-ink', 'canvas'], ['money-ink', 'surface'],
  ['alt-ink', 'surface'], ['alt-ink', 'canvas'], ['on-alt', 'alt'],
  ['on-band', 'band'], ['band-muted', 'band'], ['band-brand', 'band'],
  ['on-rail', 'rail'], ['rail-muted', 'rail'], ['on-rail', 'rail-active'],
  ['white', 'success'], ['white', 'warning'], ['white', 'danger'], ['white', 'info'],
  ['ok-ink', 'surface'], ['bad-ink', 'surface'], ['warn-ink', 'surface'], ['info-ink', 'surface'],
  ['ink', 'line'],
];
/** UI components / focus / chart marks (WCAG 1.4.11 = 3.0). */
export const UI_PAIRS: [string, string][] = [
  ['control', 'surface'], ['control', 'canvas'], ['focus', 'canvas'], ['focus', 'surface'],
  ['chart-hot', 'surface'], ['brand', 'surface'], ['money', 'rail'],
];

if (require.main === module) {
  for (const theme of ['light', 'dark'] as const) {
    const t = loadTheme(theme);
    console.log(`\n${theme}`);
    for (const [fg, bg] of [...TEXT_PAIRS, ...UI_PAIRS]) console.log(`  ${fg.padEnd(11)} on ${bg.padEnd(12)} ${contrast(t[fg], t[bg]).toFixed(2)}  ${hex(t[fg])}/${hex(t[bg])}`);
  }
}
