import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

/** Platform root for <slug>.<root> store subdomains (never accepted as a custom domain). */
export const platformRoot = () => (process.env.NEXT_PUBLIC_STOREFRONT_ROOT_DOMAIN ?? 'storeforge.local').toLowerCase();

/** Two-label public suffixes where the registrable apex has three labels (enough for the UI hint). */
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.za', 'com.br',
  'com.mx', 'co.jp', 'co.in', 'co.kr', 'com.sg', 'com.tr', 'com.cn', 'com.hk', 'com.tw', 'com.ar', 'co.il',
]);

export class InvalidHostError extends Error {}

/**
 * "https://Shop.Example.com:443/path" → "shop.example.com". IDNs become punycode.
 * Pure function; never touches the network.
 */
export function normalizeHost(input: string): string {
  let h = String(input ?? '').trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  h = h.split(/[/?#]/)[0]; // path, query, fragment
  h = h.replace(/^[^@]*@/, ''); // userinfo
  h = h.replace(/:\d*$/, ''); // port
  h = h.replace(/\.+$/, ''); // trailing dot(s)
  const ascii = domainToASCII(h);
  return ascii || h;
}

/** Validates a merchant-supplied domain. Returns the normalized host or throws InvalidHostError. */
export function validateCustomHost(input: string): string {
  const host = normalizeHost(input);
  if (!host) throw new InvalidHostError('Enter a domain like shop.example.com');
  if (isIP(host) || /^\[.*\]$/.test(host)) throw new InvalidHostError('Use a domain name, not an IP address');
  if (host.length > 253) throw new InvalidHostError('That domain is too long');
  const labels = host.split('.');
  if (labels.length < 2) throw new InvalidHostError('Enter a full domain like shop.example.com');
  for (const l of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) throw new InvalidHostError(`"${l}" isn't a valid part of a domain`);
  }
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels[labels.length - 1])) throw new InvalidHostError('That top-level domain looks wrong');
  const root = platformRoot();
  if (host === root || host.endsWith(`.${root}`)) throw new InvalidHostError(`${root} addresses are built in — add a domain you own`);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test') || host.endsWith('.example') || host.endsWith('.invalid')) {
    throw new InvalidHostError("That domain can't be reached from the internet");
  }
  return host;
}

/** Apex (example.com, example.co.uk) can't hold a CNAME at most DNS hosts → A/ALIAS records instead. */
export function isApex(host: string): boolean {
  const labels = host.split('.');
  if (labels.length === 2) return true;
  return labels.length === 3 && TWO_LEVEL_SUFFIXES.has(labels.slice(1).join('.'));
}

/** The TXT record name used for ownership proof. */
export const txtName = (host: string) => `_storeforge.${host}`;
export const txtValue = (token: string) => `storeforge-verify=${token}`;

/** www.<host> ↔ <host> twin, for redirecting the unregistered variant. */
export function wwwTwin(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : `www.${host}`;
}
