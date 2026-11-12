import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';

/**
 * Signed links in marketing emails (unsubscribe, cart recovery). EMAIL_LINK_SECRET is required
 * outside NODE_ENV=development|test; the dev fallback is derived from BETTER_AUTH_SECRET.
 * Rotating the secret only invalidates links already sent (unsubscribe links in old emails would
 * then show "link expired" with a button to email the shop), so rotate rarely.
 */
let warned = false;
function secret(): string {
  const s = process.env.EMAIL_LINK_SECRET;
  if (s) {
    if (s.length < 32) throw new Error('EMAIL_LINK_SECRET must be at least 32 characters (openssl rand -base64 32)');
    return s;
  }
  const env = process.env.NODE_ENV;
  if (env !== 'development' && env !== 'test') throw new Error(`EMAIL_LINK_SECRET is required (NODE_ENV=${env ?? 'unset'}). Generate one with: openssl rand -base64 32. Refusing to start.`);
  if (!warned && env !== 'test') {
    new Logger('EmailLinks').warn('EMAIL_LINK_SECRET not set; using a dev secret derived from BETTER_AUTH_SECRET');
    warned = true;
  }
  return `sf-email-links:${process.env.BETTER_AUTH_SECRET ?? 'dev'}`;
}
/** Called at boot. */
export function assertEmailLinkSecret() { secret(); }

export const normEmail = (e: string) => e.trim().toLowerCase();
export const emailHash = (e: string) => createHash('sha256').update(normEmail(e)).digest('hex');

const sign = (purpose: string, ...parts: string[]) =>
  createHmac('sha256', secret()).update([purpose, ...parts].join('\n')).digest('base64url').slice(0, 32);
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const unsubscribeSig = (storeId: string, hash: string) => sign('unsub', storeId, hash);
export const verifyUnsubscribe = (storeId: string, hash: string, sig: string) => typeof sig === 'string' && same(unsubscribeSig(storeId, hash), sig);
export const recoverSig = (cartId: string) => sign('recover', cartId);
export const verifyRecover = (cartId: string, sig: string) => typeof sig === 'string' && same(recoverSig(cartId), sig);

/** jane.doe@example.com → j•••e@example.com (admin lists never show full addresses) */
export function maskEmail(e: string | null | undefined) {
  if (!e) return null;
  const [u, d] = e.split('@');
  if (!d) return '•••';
  return `${u.length <= 2 ? u[0] ?? '' : `${u[0]}•••${u[u.length - 1]}`}@${d}`;
}
