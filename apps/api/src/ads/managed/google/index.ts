import { LiveGoogle } from './live';
import { StubGoogle } from './stub';
import type { GoogleAdsClient, MerchantClient } from './types';

export * from './types';
export { StubGoogle } from './stub';

type GoogleClients = GoogleAdsClient & MerchantClient;
let instance: GoogleClients | null = null;
let override: GoogleClients | null = null;

/** Live when the OAuth client, refresh token, MCC and Merchant Center ids are all set. */
export function googleLiveConfigured() {
  return ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_MCC_ID', 'GOOGLE_MERCHANT_CENTER_ID'].every((k) => process.env[k]) && process.env.GOOGLE_ADS_MODE !== 'stub';
}
export function getGoogleClient(): GoogleClients {
  if (override) return override;
  instance ??= googleLiveConfigured() ? new LiveGoogle() : new StubGoogle();
  return instance;
}
export function setGoogleClientForTests(c: GoogleClients | null) { override = c; }
