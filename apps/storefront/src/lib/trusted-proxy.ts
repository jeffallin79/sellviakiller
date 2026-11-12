/**
 * Which host header to believe (QA round 2 #3). X-Forwarded-Host is only honoured when the TCP
 * peer is a proxy on TRUSTED_PROXIES; otherwise anyone could send "X-Forwarded-Host: other-shop.com"
 * and be served (and cached as) another store. Pure; unit-tested.
 *
 * The edge middleware can't see the socket, so server.mjs stamps every request with
 *   x-sf-peer: <peer ip>;<per-boot token>
 * (any client-sent x-sf-peer is overwritten). No valid stamp (e.g. plain `next start`) → peer
 * unknown → Host is used. Fail closed.
 *
 * TRUSTED_PROXIES: comma-separated IPs / CIDRs, IPv4 or IPv6, e.g. "10.0.0.0/8,172.16.0.0/12,::1".
 * Keyword "loopback" = 127.0.0.0/8 + ::1 (Caddy on the same host).
 */
export type Cidr = { v: 4 | 6; bits: bigint; prefix: number };

const v4 = (s: string): bigint | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return p.reduce((a, n) => (a << 8n) | BigInt(n), 0n);
};
const v6 = (s: string): bigint | null => {
  if (!/^[0-9a-f:.]+$/i.test(s) || !s.includes(':')) return null;
  let str = s.toLowerCase();
  // embedded IPv4 tail (::ffff:1.2.3.4)
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (tail) {
    const n = v4(tail[1]);
    if (n === null) return null;
    str = `${str.slice(0, -tail[1].length)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n);
};

/** "::ffff:10.0.0.1" → v4 10.0.0.1; "[::1]" → ::1 */
export function parseIp(raw: string | null | undefined): { v: 4 | 6; n: bigint } | null {
  const s = String(raw ?? '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const a = v4(s);
  if (a !== null) return { v: 4, n: a };
  const b = v6(s);
  if (b === null) return null;
  if (b >> 32n === 0xffffn) return { v: 4, n: b & 0xffffffffn }; // IPv4-mapped
  return { v: 6, n: b };
}

export function parseTrustedProxies(env: string | undefined): Cidr[] {
  const out: Cidr[] = [];
  for (const raw of String(env ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (raw.toLowerCase() === 'loopback') {
      out.push(...parseTrustedProxies('127.0.0.0/8,::1/128'));
      continue;
    }
    const [ip, pre] = raw.split('/');
    const p = parseIp(ip);
    if (!p) continue; // ignore junk rather than trusting it
    const max = p.v === 4 ? 32 : 128;
    const prefix = pre === undefined ? max : Number(pre);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) continue;
    out.push({ v: p.v, bits: p.n, prefix });
  }
  return out;
}

export function isTrustedPeer(peer: string | null | undefined, list: Cidr[]): boolean {
  const p = parseIp(peer);
  if (!p) return false;
  return list.some((c) => {
    if (c.v !== p.v) return false;
    const shift = BigInt((c.v === 4 ? 32 : 128) - c.prefix);
    return p.n >> shift === c.bits >> shift;
  });
}

/** Reads the server.mjs stamp; returns the peer only if the token matches this boot's token. */
export function peerFromStamp(stamp: string | null | undefined, token: string | undefined): string | null {
  if (!stamp || !token) return null;
  const i = stamp.lastIndexOf(';');
  if (i < 1) return null;
  const given = stamp.slice(i + 1);
  if (given.length !== token.length) return null;
  let diff = 0;
  for (let k = 0; k < token.length; k++) diff |= given.charCodeAt(k) ^ token.charCodeAt(k);
  return diff === 0 ? stamp.slice(0, i) : null;
}

/** The host to route on. Multiple X-Forwarded-Host values: the first (set by the outermost trusted proxy). */
export function effectiveHost(h: { host: string | null; forwardedHost: string | null; peer: string | null }, trusted: Cidr[]): string | null {
  if (h.forwardedHost && isTrustedPeer(h.peer, trusted)) {
    const first = h.forwardedHost.split(',')[0]?.trim();
    if (first) return first;
  }
  return h.host;
}

/**
 * The shopper's IP (Meta CAPI client_ip_address). Walks X-Forwarded-For from the right, starting
 * at the real TCP peer and skipping hops that are trusted proxies; the first untrusted hop is the
 * client. Anything to the left of it is client-supplied and ignored. No stamp → null.
 */
export function clientIp(h: { peer: string | null; forwardedFor: string | null }, trusted: Cidr[]): string | null {
  if (!h.peer || !parseIp(h.peer)) return null;
  const chain = [...String(h.forwardedFor ?? '').split(',').map((x) => x.trim()).filter(Boolean), h.peer];
  let i = chain.length - 1;
  while (i > 0 && isTrustedPeer(chain[i], trusted)) i--;
  const ip = chain[i].replace(/^\[|\]$/g, '');
  return parseIp(ip) ? ip.replace(/^::ffff:/i, '') : null;
}
