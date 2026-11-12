import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';

/**
 * Ad platform tokens are stored encrypted (AES-256-GCM) and only decrypted for an API call.
 * ADS_TOKEN_KEY = 32 random bytes, base64 (`openssl rand -base64 32`). Required everywhere except
 * NODE_ENV=development|test (QA r3 #4): the dev fallback is derived from BETTER_AUTH_SECRET, so
 * rotating that secret would make every stored ad token undecryptable. Never rotate ADS_TOKEN_KEY
 * without re-sealing (tokens then fail → merchants are asked to reconnect).
 */
let warned = false;
const devKeyAllowed = () => process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
/** Called at boot: refuse to start without a usable key outside development. */
export function assertTokenKey() { key(); }
function key(): Buffer {
  const raw = process.env.ADS_TOKEN_KEY;
  if (raw) {
    const k = Buffer.from(raw, 'base64');
    if (k.length !== 32) throw new Error('ADS_TOKEN_KEY must be 32 bytes, base64-encoded');
    return k;
  }
  if (!devKeyAllowed()) throw new Error(`ADS_TOKEN_KEY is required (NODE_ENV=${process.env.NODE_ENV ?? 'unset'}). Generate one with: openssl rand -base64 32. Refusing to start.`);
  if (!warned && process.env.NODE_ENV !== 'test') {
    new Logger('TokenVault').warn('ADS_TOKEN_KEY not set; using a dev key derived from BETTER_AUTH_SECRET');
    warned = true;
  }
  return createHash('sha256').update(`sf-ads-token:${process.env.BETTER_AUTH_SECRET ?? 'dev'}`).digest();
}

export function sealToken(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

export function openToken(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised token format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
