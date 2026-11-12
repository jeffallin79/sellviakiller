import { PlatformError } from '../types';

/**
 * Meta Graph / Marketing API for managed mode (StoreForge's own Business Manager). v26.0 is current
 * (v23 expired 2026-06-09, v24 2026-10-06). Auth = system-user token of META_BUSINESS_ID +
 * appsecret_proof. Money: budgets / spend_cap / amount_spent are minor units (cents) as strings;
 * insights `spend` is a major-unit decimal string. spend_cap "0" REMOVES the cap: never send it.
 */
export const META_VERSION = () => process.env.META_GRAPH_VERSION || 'v26.0';
export interface MetaGraph {
  readonly mode: 'stub' | 'live';
  call<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, unknown>): Promise<T>;
}
export class MetaGraphError extends PlatformError {
  constructor(message: string, status: number, readonly code?: number, readonly subcode?: number, isTransient?: boolean, fbtraceId?: string) {
    super(message, 'META', { status, code, requestId: fbtraceId, transient: Boolean(isTransient) || [1, 2, 4, 17, 341, 80004].includes(code ?? -1), auth: code === 190 || code === 102, policy: code === 1487390 || subcode === 1487390 || /policy|disapprov/i.test(message) });
  }
}
