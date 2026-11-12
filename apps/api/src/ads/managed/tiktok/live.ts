import { TIKTOK_BASE, TikTokError, type TikTokClient, type TikTokEnvelope } from './types';

export class LiveTikTok implements TikTokClient {
  readonly mode = 'live' as const;
  constructor(private readonly accessToken = process.env.TIKTOK_ACCESS_TOKEN ?? '', private readonly fetchImpl: typeof fetch = fetch) {}
  private async send<T>(method: 'GET' | 'POST', path: string, payload: Record<string, unknown>): Promise<T> {
    let url = `${TIKTOK_BASE()}${path}`;
    const init: RequestInit = { method, headers: { 'Access-Token': this.accessToken, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000) };
    if (method === 'GET') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(payload)) if (v !== undefined) qs.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      url += `?${qs}`;
    } else init.body = JSON.stringify(payload);
    let res: Response;
    try { res = await this.fetchImpl(url, init); } catch (e: any) { throw new TikTokError(`Network error: ${e?.message ?? e}`, 50000, undefined, 0); }
    const j = (await res.json().catch(() => null)) as TikTokEnvelope<T> | null;
    if (!j) throw new TikTokError(`HTTP ${res.status}`, res.status >= 500 ? 50000 : 40002, undefined, res.status);
    if (j.code !== 0) throw new TikTokError(j.message, j.code, j.request_id, res.status);
    return j.data;
  }
  get<T>(path: string, params: Record<string, unknown>) { return this.send<T>('GET', path, params); }
  post<T>(path: string, body: Record<string, unknown>) { return this.send<T>('POST', path, body); }
}
