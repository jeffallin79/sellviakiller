/**
 * Certificate issuance for verified custom domains.
 *  - stub   (default): simulated, "issues" DOMAIN_STUB_TLS_DELAY_MS after the request. No network.
 *  - caddy:  Caddy on-demand TLS. Caddy asks GET /api/domains/tls-ask?domain=… before issuing; we
 *            confirm issuance by making a real HTTPS request (which also triggers it).
 *  - vercel: Vercel Domains API (DOMAIN_PROVIDER_TOKEN + VERCEL_PROJECT_ID [+ VERCEL_TEAM_ID]).
 */
import ipaddr from 'ipaddr.js';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export type TlsState = { state: 'issued' | 'pending' | 'failed'; detail?: string };
/** ip = the edge address DNS verification matched (Domain.verifiedIp); probes are pinned to it */
export type TlsCtx = { ip: string | null };

export interface TlsProvider {
  readonly kind: 'stub' | 'caddy' | 'vercel';
  request(host: string, ctx?: TlsCtx): Promise<TlsState>;
  status(host: string, ctx: { tlsRequestedAt: Date | null; now: Date } & Partial<TlsCtx>): Promise<TlsState>;
  remove(host: string): Promise<void>;
}

/**
 * Fail fast on unsafe TLS config (QA round 2 #4). Called at API boot and whenever the provider is
 * built. Caddy without an ask token would let anyone make Caddy request certificates for any host
 * that resolves to us (Let's Encrypt rate limits / abuse).
 */
export function assertTlsConfig(env: NodeJS.ProcessEnv = process.env) {
  const kind = env.DOMAIN_TLS_PROVIDER ?? 'stub';
  if (kind === 'caddy') {
    const t = env.DOMAIN_TLS_ASK_TOKEN ?? '';
    if (t.length < 24) {
      throw new Error('DOMAIN_TLS_PROVIDER=caddy requires DOMAIN_TLS_ASK_TOKEN (at least 24 random characters, same value as in the Caddyfile ask URL). Refusing to start.');
    }
  }
  if (kind === 'vercel' && !(env.DOMAIN_PROVIDER_TOKEN && env.VERCEL_PROJECT_ID)) {
    throw new Error('DOMAIN_TLS_PROVIDER=vercel requires DOMAIN_PROVIDER_TOKEN and VERCEL_PROJECT_ID. Refusing to start.');
  }
}

/**
 * Addresses our probe must never connect to. The input is canonicalised with ipaddr.js first, so
 * every spelling of an address gets the same answer (QA r3 #2): expanded / compressed / upper-case
 * IPv6 (0:0:0:0:0:0:0:1 = ::1), IPv4-mapped in dotted or hex form (::ffff:7f00:1 = 127.0.0.1,
 * ::ffff:a9fe:a9fe = 169.254.169.254), zone ids. Non-canonical IPv4 spellings (127.1, 0x7f.0.0.1,
 * 0177.0.0.1) are refused outright (node's isIP rejects them; libc would resolve them).
 *
 * IPv4: blocked = this-net, private, loopback, link-local (cloud metadata), CGNAT, multicast,
 * broadcast, 240/4, 192.0.0/24, 198.18/15. The TEST-NETs (192.0.2/24, 198.51.100/24,
 * 203.0.113/24) are allowed: they're unroutable on the internet, so harmless, and dev uses them.
 * IPv6: only global unicast is allowed. Blocked as well: everything that embeds or tunnels to an
 * IPv4 address we can't vet (IPv4-compatible ::/96, NAT64 64:ff9b::/96 and 64:ff9b:1::/48, 6to4
 * 2002::/16, Teredo 2001::/32, SIIT), plus ULA, link/site-local, multicast and documentation.
 */
const V4_TEST_NETS = ['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24'].map((c) => ipaddr.IPv4.parseCIDR(c));
const V4_BLOCKED = new Set(['unspecified', 'broadcast', 'multicast', 'linkLocal', 'loopback', 'carrierGradeNat', 'private', 'reserved', 'as112', 'amt']);
export function canonicalIp(ip: string): string | null {
  const s = String(ip ?? '').trim().replace(/^\[|\]$/g, '');
  if (!isIP(s)) return null;
  try {
    return ipaddr.process(s.replace(/%.*$/, '')).toString(); // IPv4-mapped → IPv4; IPv6 compressed lower-case
  } catch {
    return null;
  }
}
export function isBlockedAddress(ip: string): boolean {
  const c = canonicalIp(ip);
  if (!c) return true; // not an IP → never connect
  const a = ipaddr.parse(c);
  if (a.kind() === 'ipv4') {
    const v4 = a as ipaddr.IPv4;
    if (V4_TEST_NETS.some((n) => v4.match(n))) return false;
    return V4_BLOCKED.has(v4.range());
  }
  const v6 = a as ipaddr.IPv6;
  const p = v6.parts;
  if (p.slice(0, 6).every((x) => x === 0)) return true; // ::/96 (unspecified, loopback, IPv4-compatible)
  if (p[0] >= 0xfec0 && p[0] <= 0xfeff) return true; // deprecated site-local fec0::/10
  return v6.range() !== 'unicast';
}
const allowPrivateProbe = () => process.env.DOMAIN_PROBE_ALLOW_PRIVATE === 'true' && process.env.NODE_ENV !== 'production';

type RequestImpl = typeof httpsRequest;

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

/**
 * HTTPS probe pinned to the verified IP: TCP goes to `ip` (no DNS lookup at probe time, so no
 * rebinding), SNI + Host are the domain, and the certificate is validated for the domain as usual.
 * Any HTTP response means a valid cert is served. Redirects are not followed.
 */
export async function probeHttps(host: string, ip: string | null | undefined, timeoutMs = 8000, requestImpl: RequestImpl = httpsRequest): Promise<TlsState> {
  if (!ip || !isIP(ip)) return { state: 'pending', detail: 'no verified address to check yet' };
  if (isBlockedAddress(ip) && !allowPrivateProbe()) {
    return { state: 'failed', detail: `the domain points to a private or reserved address (${ip}); it must point to StoreForge's public edge` };
  }
  return new Promise<TlsState>((resolve) => {
    let done = false;
    const finish = (s: TlsState) => { if (!done) { done = true; resolve(s); } };
    const req = requestImpl(
      {
        host: canonicalIp(ip) ?? ip, // connect here (canonical form), never re-resolve
        port: 443,
        servername: host, // SNI; also the name the certificate is checked against
        method: 'HEAD',
        path: '/.well-known/storeforge-tls',
        headers: { Host: host, 'User-Agent': 'StoreForge-TLS-Check/1' },
        rejectUnauthorized: true,
        timeout: timeoutMs,
        lookup: () => { throw new Error('DNS lookup disabled for pinned probe'); },
      } as any,
      (res) => { res.resume(); finish({ state: 'issued' }); },
    );
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    req.on('error', (e: any) => finish({ state: 'pending', detail: `https not ready (${e?.code ?? e?.name ?? 'error'})` }));
    req.end();
  });
}

export class CaddyOnDemandTls implements TlsProvider {
  readonly kind = 'caddy' as const;
  async request(host: string, ctx?: TlsCtx) {
    return probeHttps(host, ctx?.ip);
  }
  async status(host: string, ctx: Partial<TlsCtx>) {
    return probeHttps(host, ctx.ip);
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
  async request(host: string, ctx?: TlsCtx): Promise<TlsState> {
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
    return this.status(host, ctx ?? {});
  }
  async status(host: string, ctx: Partial<TlsCtx> = {}): Promise<TlsState> {
    const res = await this.fetchImpl(this.url(`/v9/projects/${this.projectId}/domains/${host}`), { headers: this.headers() });
    if (!res.ok) return { state: 'pending', detail: `vercel: ${res.status}` };
    const d: any = await res.json();
    if (!d.verified) return { state: 'pending', detail: 'vercel: domain not verified yet' };
    return probeHttps(host, ctx.ip);
  }
  async remove(host: string) {
    await this.fetchImpl(this.url(`/v9/projects/${this.projectId}/domains/${host}`), { method: 'DELETE', headers: this.headers() }).catch(() => null);
  }
}

let override: TlsProvider | null = null;
export function getTls(): TlsProvider {
  if (override) return override;
  assertTlsConfig();
  const kind = process.env.DOMAIN_TLS_PROVIDER ?? 'stub';
  if (kind === 'caddy') return new CaddyOnDemandTls();
  if (kind === 'vercel') return new VercelTls();
  return new StubTls();
}
export function setTlsForTests(t: TlsProvider | null) {
  override = t;
}
