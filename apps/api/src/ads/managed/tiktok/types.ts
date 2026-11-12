import { PlatformError } from '../types';

/**
 * TikTok API for Business v1.3. Base https://business-api.tiktok.com/open_api/v1.3, header
 * `Access-Token: <long-term token of the Business Center admin, from the developer app>`.
 * Every response is the envelope { code, message, request_id, data }; code 0 = success.
 * Money is in major units (decimal strings/numbers) of the advertiser currency.
 */
export const TIKTOK_BASE = () => process.env.TIKTOK_API_BASE || 'https://business-api.tiktok.com/open_api/v1.3';

export type TikTokEnvelope<T> = { code: number; message: string; request_id: string; data: T };

export interface TikTokClient {
  readonly mode: 'stub' | 'live';
  get<T = any>(path: string, params: Record<string, unknown>): Promise<T>;
  post<T = any>(path: string, body: Record<string, unknown>): Promise<T>;
}

const TRANSIENT = new Set([40100, 40102, 40700, 50000, 50002, 51003]);
const AUTH = new Set([40001, 40104, 40105, 40106]);
export class TikTokError extends PlatformError {
  constructor(message: string, readonly code: number, requestId?: string, status = 200) {
    super(message, 'TIKTOK', { status, code, requestId, transient: TRANSIENT.has(code), auth: AUTH.has(code), policy: code === 40911 || /audit|review|violat/i.test(message) });
  }
}
/** Major-unit decimal ↔ minor units */
export const toMajor = (minor: number) => Number((Math.round(minor) / 100).toFixed(2));
export const fromMajor = (v: string | number | undefined) => Math.round(Number(v ?? 0) * 100);
