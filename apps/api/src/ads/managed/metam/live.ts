import { createHmac } from 'node:crypto';
import { META_VERSION, MetaGraphError, type MetaGraph } from './types';

export class LiveMetaGraph implements MetaGraph {
  readonly mode = 'live' as const;
  constructor(private readonly token = process.env.META_SYSTEM_USER_TOKEN ?? '', private readonly appSecret = process.env.META_APP_SECRET ?? '', private readonly fetchImpl: typeof fetch = fetch) {}
  async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, unknown> = {}): Promise<T> {
    const q = new URLSearchParams();
    const all: Record<string, unknown> = { ...params, access_token: this.token, appsecret_proof: createHmac('sha256', this.appSecret).update(this.token).digest('hex') };
    for (const [k, v] of Object.entries(all)) if (v !== undefined) q.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    const base = `https://graph.facebook.com/${META_VERSION()}/${path.replace(/^\//, '')}`;
    let res: Response;
    try {
      res = method === 'GET'
        ? await this.fetchImpl(`${base}?${q}`, { signal: AbortSignal.timeout(30_000) })
        : await this.fetchImpl(base, { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: q, signal: AbortSignal.timeout(30_000) });
    } catch (e: any) {
      throw new MetaGraphError(`Network error: ${e?.message ?? e}`, 0, undefined, undefined, true);
    }
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || j.error) {
      const e = j.error ?? {};
      throw new MetaGraphError(e.error_user_msg ?? e.message ?? `HTTP ${res.status}`, res.status, e.code, e.error_subcode, e.is_transient, e.fbtrace_id);
    }
    return j as T;
  }
}
