import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { classifyHost, decide, needsResolve, type Resolved } from '@/lib/host-routing';

const ROOT = process.env.NEXT_PUBLIC_STOREFRONT_ROOT_DOMAIN ?? 'storeforge.local';
// Server-side API base (can be an internal address); falls back to the public one.
const API = (process.env.STOREFRONT_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** Small per-instance cache: 60 s for hits, 15 s for misses, so new domains go live quickly. */
const cache = new Map<string, { at: number; ttl: number; value: Resolved }>();
async function resolve(host: string): Promise<Resolved | 'error'> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  try {
    const res = await fetch(`${API}/api/storefront/resolve-host?host=${encodeURIComponent(host)}`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (res.status === 404) {
      cache.set(host, { at: Date.now(), ttl: 15_000, value: null });
      return null;
    }
    if (!res.ok) return hit?.value ?? 'error';
    const value = (await res.json()) as Resolved;
    if (cache.size > 5000) cache.clear();
    cache.set(host, { at: Date.now(), ttl: 60_000, value });
    return value;
  } catch {
    return hit?.value ?? 'error'; // serve stale over failing
  }
}

export async function middleware(req: NextRequest) {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const c = classifyHost(host, ROOT);
  const { pathname, search } = req.nextUrl;
  const resolved = needsResolve(c) ? await resolve(c.kind === 'custom' ? c.host : `${(c as any).slug}.${ROOT}`) : undefined;
  const d = decide(c, pathname, search, resolved);

  const headers = new Headers(req.headers);
  switch (d.action) {
    case 'redirect':
      return NextResponse.redirect(d.location, d.status);
    case 'unknown': {
      const url = req.nextUrl.clone();
      url.pathname = '/unknown-domain';
      url.search = `?host=${encodeURIComponent(d.host)}`;
      return NextResponse.rewrite(url, { status: d.status });
    }
    case 'rewrite': {
      headers.set('x-sf-base', d.base);
      const url = req.nextUrl.clone();
      url.pathname = d.pathname;
      return NextResponse.rewrite(url, { request: { headers } });
    }
    default:
      headers.set('x-sf-base', d.base);
      return NextResponse.next({ request: { headers } });
  }
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|api).*)'],
};
