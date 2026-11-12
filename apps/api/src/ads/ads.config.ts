import type { AdAccountMode } from '@storeforge/db';

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : d;
};

/**
 * Fee on ad spend (blueprint: ADS_FEE_PCT, default 15).
 *   MANAGED (StoreForge's ad account): fuel pays spend + fee.
 *   OWNED ("connect your own"): Meta bills the merchant's card for spend directly, so fuel only
 *   pays the fee, ADS_OWNED_FEE_PCT (default 0 until Jeff decides).
 */
export const feePct = (mode: AdAccountMode | 'MANAGED' | 'OWNED') =>
  mode === 'MANAGED' ? num(process.env.ADS_FEE_PCT, 15) : num(process.env.ADS_OWNED_FEE_PCT, 0);
/** Does this campaign draw on Ad Fuel at all? (paused when fuel runs out) */
export const usesFuel = (mode: AdAccountMode | 'MANAGED' | 'OWNED') => mode === 'MANAGED' || feePct(mode) > 0;
export const minDailyCents = () => Math.max(100, num(process.env.ADS_MIN_DAILY_CENTS, 500));
export const MAX_DAILY_CENTS = 1_000_000;
export const feeFor = (spendCents: number, mode: AdAccountMode | 'MANAGED' | 'OWNED') => Math.round((spendCents * feePct(mode)) / 100);
/** Meta's learning phase ends after ~50 optimisation events in 7 days → STEADY */
export const STEADY_PURCHASES_7D = 50;
export const apiPublicUrl = () => (process.env.API_PUBLIC_URL ?? process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
export const adminUrl = () => (process.env.ADMIN_URL ?? 'http://localhost:3001').replace(/\/$/, '');
export const metaRedirectUri = () => `${apiPublicUrl()}/api/boost/meta/callback`;
