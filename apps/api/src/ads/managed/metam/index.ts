import { LiveMetaGraph } from './live';
import { StubMetaGraph } from './stub';
import type { MetaGraph } from './types';

export * from './types';
export { StubMetaGraph } from './stub';
let instance: MetaGraph | null = null;
let override: MetaGraph | null = null;
/** Live managed Meta needs the business, a system-user token, the app secret, and the Page ads run as. */
export function metaManagedLiveConfigured() {
  return ['META_BUSINESS_ID', 'META_SYSTEM_USER_TOKEN', 'META_APP_SECRET', 'META_MANAGED_PAGE_ID'].every((k) => process.env[k]) && process.env.META_MODE !== 'stub';
}
export function getMetaGraph(): MetaGraph {
  if (override) return override;
  instance ??= metaManagedLiveConfigured() ? new LiveMetaGraph() : new StubMetaGraph();
  return instance;
}
export function setMetaGraphForTests(c: MetaGraph | null) { override = c; }
