import { LiveMetaClient } from './live';
import { StubMetaClient } from './stub';
import type { MetaMarketingClient } from './types';

export * from './types';
export { StubMetaClient } from './stub';

let override: MetaMarketingClient | null = null;
let stub: StubMetaClient | null = null;

/** Live only with app credentials; otherwise the stub (OAuth, accounts, campaigns, insights, CAPI). */
export function isMetaLive() {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET) && process.env.META_MODE !== 'stub';
}
export function getMetaClient(): MetaMarketingClient {
  if (override) return override;
  if (isMetaLive()) return new LiveMetaClient();
  stub ??= new StubMetaClient();
  return stub;
}
export function setMetaClientForTests(c: MetaMarketingClient | null) {
  override = c;
}
