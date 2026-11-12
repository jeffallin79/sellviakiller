import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTheme, contrast, hex, TEXT_PAIRS, UI_PAIRS } from '../scripts/contrast';

const light = loadTheme('light');

test('blueprint §6 token values are exact', () => {
  const want: Record<string, string> = {
    primary: '#A3153F', 'primary-dark': '#F06A8E', accent: '#F5B32E', 'accent-ink': '#8A5A00', secondary: '#1F5F66',
    'secondary-dark': '#7FC4C8', bg: '#FBF6F0', border: '#E8DCCD', text: '#2B1E27', 'bg-dark': '#1C1219',
    'surface-dark': '#2A1D26', 'text-dark': '#F3E9EE', success: '#2E7D4F', warning: '#965A00', danger: '#B3261E', info: '#3559A8',
  };
  for (const [k, v] of Object.entries(want)) assert.equal(hex(light[k]), v, `--sf-${k}`);
});

test('brand/contrast.txt AA pairs hold (and match within 0.02)', () => {
  const names: Record<string, string> = {
    'ink-700': 'text', paper: 'bg', mist: 'text-dark', 'ink-900': 'bg-dark', white: 'white', 'garnet-600': 'primary',
    'garnet-400': 'primary-dark', 'saffron-400': 'accent', 'ink-800': 'surface-dark', 'lagoon-300': 'secondary-dark',
    'lagoon-700': 'secondary', 'saffron-700': 'accent-ink', success: 'success', warning: 'warning', danger: 'danger', info: 'info',
  };
  const lines = readFileSync(join(__dirname, '../../../brand/contrast.txt'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 14);
  for (const line of lines) {
    const m = line.match(/^(.+?) on (.+?): ([\d.]+)$/);
    assert.ok(m, `parse: ${line}`);
    const [fg, bg] = [names[m![1].trim()], names[m![2].trim()]];
    assert.ok(fg && bg, `unknown name in: ${line}`);
    const c = contrast(light[fg], light[bg]);
    assert.ok(c >= 4.5, `${line} → ${c.toFixed(2)} < 4.5`);
    assert.ok(Math.abs(c - Number(m![3])) < 0.02, `${line} → computed ${c.toFixed(2)}`);
  }
});

for (const theme of ['light', 'dark'] as const) {
  const t = loadTheme(theme);
  test(`${theme}: every text role pair is AA (≥4.5)`, () => {
    for (const [fg, bg] of TEXT_PAIRS) {
      assert.ok(t[fg] && t[bg], `missing token ${fg}/${bg}`);
      const c = contrast(t[fg], t[bg]);
      assert.ok(c >= 4.5, `${theme} ${fg} on ${bg} = ${c.toFixed(2)}`);
    }
  });
  test(`${theme}: UI components/focus ≥3:1`, () => {
    for (const [fg, bg] of UI_PAIRS) {
      const c = contrast(t[fg], t[bg]);
      assert.ok(c >= 3, `${theme} ${fg} on ${bg} = ${c.toFixed(2)}`);
    }
  });
}

test('no blue/violet brand hues (Sellvia rule): brand/money/alt hues are not in 210°–300°', () => {
  const hue = ([r, g, b]: number[]) => {
    const [R, G, B] = [r / 255, g / 255, b / 255];
    const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
    if (!d) return -1;
    const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (const theme of ['light', 'dark'] as const) {
    const t = loadTheme(theme);
    for (const k of ['brand', 'money', 'alt', 'rail', 'band', 'canvas']) {
      const h = hue(t[k]);
      assert.ok(h < 210 || h > 300, `${theme} ${k} hue ${h.toFixed(0)}° is blue/violet`);
    }
  }
});
