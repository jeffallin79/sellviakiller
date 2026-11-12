/**
 * Boost managed budget split, shared by the API (what is actually set on each platform) and the
 * admin preview, so the two can't drift (QA r4 a).
 *
 * Platform minimums come first (Meta $1, Google $1, TikTok ad group $20 per day), then whatever is
 * left is divided by weight: Meta 40%, Google 40%, TikTok 20%. So the shares of the TOTAL are not
 * 40/40/20: at $60 → Meta $16.20, Google $16.20, TikTok $27.60.
 */
export type BudgetChannel = 'META' | 'GOOGLE' | 'TIKTOK';
export const CHANNEL_MIN_CENTS: Record<BudgetChannel, number> = { META: 100, GOOGLE: 100, TIKTOK: 2000 };
/** Weight of the budget left after minimums */
export const CHANNEL_WEIGHT: Record<BudgetChannel, number> = { META: 0.4, GOOGLE: 0.4, TIKTOK: 0.2 };

/** Cents per channel; sums exactly to total (the last channel gets the rounding remainder). */
export function splitBudget(total: number, channels: BudgetChannel[]): Record<string, number> {
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
