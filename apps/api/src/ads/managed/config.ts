import type { Channel } from './types';

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : d;
};
/** Total managed daily budget minimum across channels (cents) */
export const managedMinDailyCents = () => num(process.env.ADS_MANAGED_MIN_DAILY_CENTS, 1000);
/** Platform minimums per channel per day (TikTok ad group: $20/day) */
export const CHANNEL_MIN_CENTS: Record<Channel, number> = { META: 100, GOOGLE: 100, TIKTOK: 2000 };
/** Default share of a total budget after minimums are met */
export const CHANNEL_WEIGHT: Record<Channel, number> = { META: 0.4, GOOGLE: 0.4, TIKTOK: 0.2 };
/** Blueprint budget ladder: cumulative group spend (cents) → daily budget (cents) */
export const LADDER: { atSpendCents: number; dailyCents: number }[] = [
  { atSpendCents: 14_000, dailyCents: 1_500 },
  { atSpendCents: 28_000, dailyCents: 2_000 },
  { atSpendCents: 56_000, dailyCents: 3_000 },
  { atSpendCents: 168_000, dailyCents: 5_000 },
];
/** Reconcile: alert above this drift (basis points; 100 = 1%) */
export const RECONCILE_ALERT_BPS = () => num(process.env.ADS_RECONCILE_ALERT_BPS, 100);
export const RECONCILE_DAYS = 7;
/** AC: product pick → live on every channel in under 3 minutes */
export const LAUNCH_TARGET_MS = 180_000;
export const PROVISION_LEASE_MS = 2 * 60_000;
export const LAUNCH_LEASE_MS = 2 * 60_000;
export const CAP_LEASE_MS = 60_000;
export const enabledChannels = (): Channel[] =>
  (process.env.ADS_MANAGED_CHANNELS ?? 'META,GOOGLE,TIKTOK').split(',').map((s) => s.trim().toUpperCase()).filter((c): c is Channel => c === 'META' || c === 'GOOGLE' || c === 'TIKTOK');

/** Split a total across channels: platform minimums first, then the rest by weight (cents, sums exactly). */
export function splitBudget(total: number, channels: Channel[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!channels.length) return out;
  let rest = total;
  for (const c of channels) { out[c] = CHANNEL_MIN_CENTS[c]; rest -= CHANNEL_MIN_CENTS[c]; }
  if (rest < 0) return out; // caller validates the minimum
  const w = channels.reduce((n, c) => n + CHANNEL_WEIGHT[c], 0);
  let given = 0;
  channels.forEach((c, i) => {
    const add = i === channels.length - 1 ? rest - given : Math.floor((rest * CHANNEL_WEIGHT[c]) / w);
    out[c] += add;
    given += add;
  });
  return out;
}
export const minTotalFor = (channels: Channel[]) => Math.max(managedMinDailyCents(), channels.reduce((n, c) => n + CHANNEL_MIN_CENTS[c], 0));
