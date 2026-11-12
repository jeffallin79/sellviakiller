import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type OutgoingEmail = {
  id: string;
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  tags?: Record<string, string>;
  /** Extra headers (List-Unsubscribe / List-Unsubscribe-Post on marketing mail) */
  headers?: Record<string, string>;
};

export interface EmailTransport {
  readonly kind: 'resend' | 'outbox';
  send(m: OutgoingEmail): Promise<{ providerMessageId: string | null }>;
}

export class PermanentEmailError extends Error {}

/** Resend REST API. Idempotency-Key makes retries safe (Resend keeps keys 24 h). */
export class ResendTransport implements EmailTransport {
  readonly kind = 'resend' as const;
  constructor(private apiKey = process.env.RESEND_API_KEY ?? '', private fetchImpl: typeof fetch = fetch) {}
  async send(m: OutgoingEmail) {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': m.idempotencyKey },
      body: JSON.stringify({
        from: m.from,
        to: [m.to],
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
        subject: m.subject,
        html: m.html,
        text: m.text,
        ...(m.headers && Object.keys(m.headers).length ? { headers: m.headers } : {}),
        ...(m.tags ? { tags: Object.entries(m.tags).map(([name, value]) => ({ name, value: value.replace(/[^A-Za-z0-9_-]/g, '_') })) } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = `resend ${res.status}: ${body?.message ?? body?.name ?? 'error'}`;
      // 4xx other than rate limit won't succeed on retry (bad from-domain, invalid address…)
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new PermanentEmailError(msg);
      throw new Error(msg);
    }
    return { providerMessageId: body?.id ?? null };
  }
}

/** Dev outbox: writes <id>.html + <id>.json to EMAIL_OUTBOX_DIR. Nothing leaves the machine. */
export class OutboxTransport implements EmailTransport {
  readonly kind = 'outbox' as const;
  constructor(private dir = resolve(process.env.EMAIL_OUTBOX_DIR ?? join(process.cwd(), '.outbox'))) {}
  async send(m: OutgoingEmail) {
    mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = join(this.dir, `${stamp}-${m.id}`);
    writeFileSync(`${base}.html`, m.html);
    writeFileSync(`${base}.json`, JSON.stringify({ ...m, html: undefined }, null, 2));
    return { providerMessageId: `outbox:${base}.html` };
  }
}

let override: EmailTransport | null = null;
export function getEmailTransport(): EmailTransport {
  if (override) return override;
  return process.env.RESEND_API_KEY ? new ResendTransport() : new OutboxTransport();
}
export function setEmailTransportForTests(t: EmailTransport | null) {
  override = t;
}
