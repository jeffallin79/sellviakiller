import { LiveTikTok } from './live';
import { StubTikTok } from './stub';
import type { TikTokClient } from './types';

export * from './types';
export { StubTikTok } from './stub';

let instance: TikTokClient | null = null;
let override: TikTokClient | null = null;
/** Live when the developer app's long-term token and the Business Center id are set. */
export function tiktokLiveConfigured() {
  return ['TIKTOK_APP_ID', 'TIKTOK_APP_SECRET', 'TIKTOK_ACCESS_TOKEN', 'TIKTOK_BC_ID'].every((k) => process.env[k]) && process.env.TIKTOK_MODE !== 'stub';
}
export function getTikTokClient(): TikTokClient {
  if (override) return override;
  instance ??= tiktokLiveConfigured() ? new LiveTikTok() : new StubTikTok();
  return instance;
}
export function setTikTokClientForTests(c: TikTokClient | null) { override = c; }
