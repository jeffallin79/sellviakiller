/**
 * Host-based store routing (pure; unit-tested). The middleware feeds it the request host + path
 * and, when needed, the API's answer from GET /api/storefront/resolve-host.
 *
 *   demo.storeforge.local/p/1      → rewrite /s/demo/p/1          (platform subdomain)
 *   shop.juniper.com/p/1           → rewrite /s/juniper/p/1       (ACTIVE custom domain)
 *   shop.juniper.com/s/juniper/p/1 → 308 /p/1                     (one canonical URL)
 *   juniper.com (www registered)   → 308 https://www.juniper.com  (www twin)
 *   demo.storeforge.local (has custom domain) → 308 https://shop.juniper.com
 *   unknown.example.org            → branded "no shop here" page, 404
 */
export type HostClass = { kind: 'platform' } | { kind: 'subdomain'; slug: string } | { kind: 'custom'; host: string };
export type Resolved = { slug: string; kind: 'subdomain' | 'custom'; redirectTo?: string } | null;
export type Decision =
  | { action: 'next'; base: string }
  | { action: 'rewrite'; pathname: string; base: string }
  | { action: 'redirect'; location: string; status: 308 }
  | { action: 'unknown'; host: string; status: 404 | 503 };

const RESERVED = new Set(['www', 'admin', 'api', 'stores']);
/** Paths that exist at the site root on every host (not per-shop). */
const GLOBAL = [/^\/catalog\//, /^\/checkout(\/|$)/, /^\/unknown-domain(\/|$)/, /^\/_next\//, /^\/favicon\.ico$/];

export function hostnameOf(hostHeader: string | null | undefined): string {
  return String(hostHeader ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

export function classifyHost(hostHeader: string | null | undefined, root: string): HostClass {
  const h = hostnameOf(hostHeader);
  const r = root.toLowerCase();
  if (!h || h === r || h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[')) return { kind: 'platform' };
  for (const suffix of [`.${r}`, '.localhost']) {
    if (h.endsWith(suffix)) {
      const slug = h.slice(0, -suffix.length);
      if (!slug || slug.includes('.') || RESERVED.has(slug)) return { kind: 'platform' };
      return { kind: 'subdomain', slug };
    }
  }
  return { kind: 'custom', host: h };
}

/** Does this host need an API lookup? (Subdomains do too, to redirect to a custom domain.) */
export const needsResolve = (c: HostClass) => c.kind !== 'platform';

const pathBase = (pathname: string) => {
  const m = /^\/s\/([^/]+)/.exec(pathname);
  return m ? `/s/${m[1]}` : '';
};
const shopPath = (slug: string, pathname: string) => `/s/${slug}${pathname === '/' ? '' : pathname}`;

export function decide(
  c: HostClass,
  pathname: string,
  search: string,
  resolved: Resolved | 'error' | undefined,
): Decision {
  if (c.kind === 'platform') return { action: 'next', base: pathBase(pathname) };
  const isGlobal = GLOBAL.some((re) => re.test(pathname));

  if (c.kind === 'subdomain') {
    if (resolved && resolved !== 'error' && resolved.redirectTo) {
      return { action: 'redirect', location: `https://${resolved.redirectTo}${pathname.replace(/^\/s\/[^/]+/, '') || '/'}${search}`, status: 308 };
    }
    // API down or unknown slug: still route by slug (the shop page shows "isn't open" if needed).
    if (isGlobal) return { action: 'next', base: '' };
    if (pathname.startsWith('/s/')) return { action: 'next', base: pathBase(pathname) };
    return { action: 'rewrite', pathname: shopPath(c.slug, pathname), base: '' };
  }

  // custom domain
  if (resolved === 'error') return { action: 'unknown', host: c.host, status: 503 };
  if (!resolved) return { action: 'unknown', host: c.host, status: 404 };
  if (resolved.redirectTo) return { action: 'redirect', location: `https://${resolved.redirectTo}${pathname}${search}`, status: 308 };
  if (isGlobal) return { action: 'next', base: '' };
  const prefix = `/s/${resolved.slug}`;
  if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
    return { action: 'redirect', location: `https://${c.host}${pathname.slice(prefix.length) || '/'}${search}`, status: 308 };
  }
  if (pathname.startsWith('/s/')) return { action: 'unknown', host: c.host, status: 404 }; // other shops aren't reachable here
  return { action: 'rewrite', pathname: shopPath(resolved.slug, pathname), base: '' };
}

/** Build a shop link from the base the middleware reported ('' on subdomain/custom hosts, '/s/<slug>' in path mode). */
export function shopHref(base: string, path = '/'): string {
  if (path.startsWith('#')) return `${base || '/'}${path}`;
  const p = path.startsWith('/') ? path : `/${path}`;
  return p === '/' ? base || '/' : `${base}${p}`;
}
