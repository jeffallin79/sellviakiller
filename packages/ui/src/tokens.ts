/** Token names for tooling/tests. Values live in ../tokens.css (single source of truth). */
export const roleTokens = [
  'canvas', 'surface', 'surface-2', 'ink', 'muted', 'line', 'control', 'brand', 'on-brand', 'money', 'on-money',
  'money-ink', 'alt', 'on-alt', 'alt-ink', 'band', 'on-band', 'band-muted', 'band-brand', 'rail', 'on-rail',
  'rail-muted', 'rail-active', 'focus', 'ok-ink', 'warn-ink', 'bad-ink', 'info-ink', 'chart-rest', 'chart-hot',
] as const;
export type RoleToken = (typeof roleTokens)[number];
export const cssVar = (t: RoleToken) => `rgb(var(--sf-${t}))`;
