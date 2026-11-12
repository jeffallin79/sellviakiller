/**
 * Certificate issuance for verified custom domains.
 *  - stub   (default): simulated, "issues" DOMAIN_STUB_TLS_DELAY_MS after the request. No network.
 *  - caddy:  Caddy on-demand TLS. Caddy asks GET /api/domains/tls-ask?domain=… before issuing; we
 *            confirm issuance by making a real HTTPS request (which also triggers it).
 *  - vercel: Vercel Domains API (DOMAIN_PROVIDER_TOKEN + VERCEL_PROJECT_ID [+ VERCEL_TEAM_ID]).
 */
export type TlsState = { state: 'issued' | 'pending' | 'failed'; detail?: string };

export interface TlsProvider {
  readonly kind: 'stub' | 'caddy' | 'vercel';
  request(host: string): Promise<TlsState>;
  status(host: string, ctx: { tlsRequestedAt: Date | null; now: Date }): Promise<TlsState>;
  remove(host: string): Promise<void>;
}

export class StubTls implements TlsProvider {
  readonly kind = 'stub' as const;
  constructor(private delayMs = Number(process.env.DOMAIN_STUB_TLS_DELAY_MS ?? 20000)) {}
  async request(): Promise<TlsState> {
    return this.delayMs <= 0 ? { state: 'issued', detail: 'stub certificate' } : { state: 'pending', detail: 'stub: issuing' };
  }
  async status(_host: string, ctx: { tlsRequestedAt: Date | null; now: Date }): Promise<TlsState> {
    const since = ctx.tlsRequestedAt ? ctx.now.getTime() - ctx.tlsRequestedAt.getTime() : 0;
    return since >= this.delayMs ? { state: 'issued', detail: 'stub certificate' } : { state: 'pending', detail: 'stub: issuing' };
  }
  async remove() {}
}

/** HTTPS probe with normal certificate validation. Any HTTP response means a valid cert is served. */
export async function probeHttps(host: string, timeoutMs = 8000): Promise<TlsState> {
  try {
    await fetch(`https://${host}/.well-known/storeforge-tls`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { state: 'issued' };
  } catch (e: any) {
    const code = e?.cause?.code ?? e?.code ?? e?.name ?? 'error';
    return { state: 'pending', detail: `https not ready (${code})` };
  }
}

export class CaddyOnDemandTls implements TlsProvider {
  readonly kind = 'caddy' as const;
  async request(host: string) {
    return probeHttps(host);
  }
  async status(host: string) {
    return probeHttps(host);
  }
  async remove() {
    /* Caddy stops renewing once tls-ask returns 404 for the host */
  }
}

export class VercelTls implements TlsProvider {
  readonly kind = 'vercel' as const;
  constructor(
    private token = process.env.DOMAIN_PROVIDER_TOKEN ?? '',
    private projectId = process.env.VERCEL_PROJECT_ID ?? '',
    private teamId = process.env.VERCEL_TEAM_ID ?? '',
    private fetchImpl: typeof fetch = fetch,
  ) {}
  private url(path: string) {
    const q = this.teamId ? `?teamId=${encodeURIComponent(this.teamId)}` : '';
    return `https://api.vercel.com${path}${q}`;
  }
  private headers() {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }
  async request(host: string): Promise<TlsState> {
    const res = await this.fetchImpl(this.url(`/v10/projects/${this.projectId}/domains`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name: host }),
    });
    if (!res.ok) {
      const body: any = await res.json().catch(() => ({}));
      // already attached to this project → fine, keep polling
      if (body?.error?.code !== 'domain_already_in_use' && res.status !== 409) {
        return { state: 'failed', detail: `vercel: ${body?.error?.message ?? res.status}` };
      }
    }
    return this.status(host);
  }
  async status(host: string): Promise<TlsState> {
    const res = await this.fetchImpl(this.url(`/v9/projects/${this.projectId}/domains/${host}`), { headers: this.headers() });
    if (!res.ok) return { state: 'pending', detail: `vercel: ${res.status}` };
    const d: any = await res.json();
    if (!d.verified) return { state: 'pending', detail: 'vercel: domain not verified yet' };
    return probeHttps(host);
  }
  async remove(host: string) {
    await this.fetchImpl(this.url(`/v9/projects/${this.projectId}/domains/${host}`), { method: 'DELETE', headers: this.headers() }).catch(() => null);
  }
}

let override: TlsProvider | null = null;
export function getTls(): TlsProvider {
  if (override) return override;
  const kind = process.env.DOMAIN_TLS_PROVIDER ?? 'stub';
  if (kind === 'caddy') return new CaddyOnDemandTls();
  if (kind === 'vercel' && process.env.DOMAIN_PROVIDER_TOKEN && process.env.VERCEL_PROJECT_ID) return new VercelTls();
  return new StubTls();
}
export function setTlsForTests(t: TlsProvider | null) {
  override = t;
}
