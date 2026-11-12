#!/usr/bin/env node
// Fails if any CSS file under the given dirs contains a raw colour (hex, rgb()/hsl() without
// var(), or a named colour in a colour property). Tokens live only in packages/ui/tokens.css.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z_-])/;
const FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((?!\s*var\()/;
const NAMED = /(?:^|[;{\s])(?:color|background(?:-color)?|border(?:-[a-z]+)?-color|border|outline|fill|stroke|box-shadow|text-decoration-color|accent-color)\s*:[^;]*\b(?:white|black|red|green|blue|yellow|orange|purple|violet|pink|gr[ae]y|silver|navy|teal|maroon|olive|lime|aqua|fuchsia|indigo|crimson|gold)\b/i;
const dirs = process.argv.slice(2);
let bad = 0;
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (f === 'node_modules' || f === '.next') continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.css') && !p.endsWith('tokens.css')) { // tokens.css is the one place raw values live
      readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n').forEach((line, i) => {
        if (HEX.test(line) || FN.test(line) || NAMED.test(line)) {
          bad++;
          console.error(`${relative(process.cwd(), p)}:${i + 1}: raw colour → use a --sf-* token: ${line.trim()}`);
        }
      });
    }
  }
};
dirs.forEach(walk);
if (bad) { console.error(`\n${bad} raw colour(s) found.`); process.exit(1); }
console.log(`check-colors: OK (${dirs.join(', ')})`);
