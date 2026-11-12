import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { prisma, Prisma } from '@storeforge/db';
import { CART_CONSENT_TEXT, type CartCaptureInput } from '@storeforge/shared';
import { EmailService, fromHeader, headerLine } from '../email/email.service';
import { renderCartEmail } from '../email/templates';
import { emailHash, maskEmail, normEmail, recoverSig, unsubscribeSig, verifyRecover, verifyUnsubscribe } from '../email/links';
import { enqueueEmailSend } from '../jobs/queues';
import { DomainsService } from '../domains/domains.service';
import { apiPublicUrl } from '../ads/ads.config';
import { cartConfig } from './config';
import { paidOrderFor } from './lifecycle';

type Line = { storeProductId: string; quantity: number; title: string; unitPriceCents: number };
const SCRUB = { email: null, customerName: null } as const;

/** Small in-memory limiter for the public capture endpoint (per client IP + shop). */
const hits = new Map<string, number[]>();
function limited(key: string, max = 60, windowMs = 10 * 60_000) {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return arr.length > max;
}

/**
 * Abandoned-cart recovery (blueprint slice 5).
 *  - Consent: a cart is stored only after the shopper typed an email AND ticked the reminder box
 *    (exact wording saved). Unticking scrubs the email. Suppressed addresses are never stored.
 *  - Two reminders max per cart: 1 h and 24 h after the last activity, one sequence per address
 *    per store per 7 days. Written to the existing email outbox (EmailMessage, `email.send` queue).
 *  - Idempotent: the cart's reminderNAt is claimed in the same transaction that writes the outbox
 *    row, and the row's dedupeKey is CART_REMINDER_N:<cartId>. Sweepers on several instances,
 *    restarts and replays can't send twice. Delivery re-checks consent/unsubscribe/conversion.
 *  - Every reminder has a signed one-click unsubscribe (List-Unsubscribe + RFC 8058 POST) and the
 *    shop's postal address; stores without a mailing address send none.
 */
@Injectable()
export class CartsService {
  private readonly logger = new Logger(CartsService.name);
  constructor(private readonly emails: EmailService) {}

  async capture(input: CartCaptureInput, clientKey: string): Promise<{ stored: boolean; id?: string; rotate?: boolean; withdrawn?: boolean; reason?: 'unsubscribed' }> {
    // Per shopper (IP from the storefront proxy), per cart token, and per shop overall (the IP header
    // can be forged by someone calling the API directly, so the shop-wide cap is the backstop).
    if (limited(`ip|${clientKey}|${input.storeSlug}`) || limited(`tok|${input.token}`, 120) || limited(`shop|${input.storeSlug}`, 3000))
      throw new BadRequestException('Too many updates, try again in a few minutes');
    const store = await prisma.store.findFirst({ where: { slug: input.storeSlug, deletedAt: null, status: 'ACTIVE' }, select: { id: true } });
    if (!store) throw new NotFoundException('Store not found');
    const key = { storeId_token: { storeId: store.id, token: input.token } };
    const existing = await prisma.cart.findUnique({ where: key });
    if (existing && existing.status !== 'OPEN') return { stored: false, rotate: true }; // token belongs to a finished cart

    if (!input.consent || !input.email) {
      if (existing) {
        await prisma.cart.updateMany({ where: { id: existing.id, status: 'OPEN' }, data: { consent: false, consentAt: null, consentText: null, ...SCRUB } });
        await this.cancelQueued([existing.id], 'no_consent');
      }
      return { stored: false, withdrawn: !!existing };
    }
    const email = normEmail(input.email);
    const hash = emailHash(email);
    const suppressed = await prisma.emailSuppression.findUnique({ where: { storeId_emailHash: { storeId: store.id, emailHash: hash } } });
    if (suppressed) {
      if (existing) await prisma.cart.updateMany({ where: { id: existing.id, status: 'OPEN' }, data: { consent: false, consentAt: null, consentText: null, ...SCRUB } });
      return { stored: false, reason: 'unsubscribed' as const };
    }
    const lines = await this.price(store.id, input.lines);
    const data = {
      email,
      emailHash: hash,
      customerName: input.name || null,
      lines: lines as Prisma.InputJsonValue,
      itemCount: lines.reduce((a, l) => a + l.quantity, 0),
      subtotalCents: lines.reduce((a, l) => a + l.unitPriceCents * l.quantity, 0),
      consent: true,
      consentText: CART_CONSENT_TEXT,
      lastActivityAt: new Date(),
    };
    if (existing) {
      const keepConsentAt = existing.consent && existing.consentAt && existing.emailHash === hash;
      await prisma.cart.updateMany({ where: { id: existing.id, status: 'OPEN' }, data: { ...data, consentAt: keepConsentAt ? existing.consentAt : new Date() } });
      return { stored: true, id: existing.id };
    }
    try {
      const c = await prisma.cart.create({ data: { ...data, storeId: store.id, token: input.token, consentAt: new Date() } });
      return { stored: true, id: c.id };
    } catch (e: any) {
      if (e?.code === 'P2002') return this.capture(input, clientKey); // raced another tab
      throw e;
    }
  }

  /** Server-side prices; products no longer on sale in this shop are dropped. */
  private async price(storeId: string, lines: { storeProductId: string; quantity: number }[]): Promise<Line[]> {
    if (!lines.length) return [];
    const sps = await prisma.storeProduct.findMany({
      where: { id: { in: lines.map((l) => l.storeProductId) }, storeId, active: true, deletedAt: null },
      include: { product: { select: { title: true } } },
    });
    const by = new Map(sps.map((s) => [s.id, s]));
    return lines.filter((l) => by.has(l.storeProductId)).map((l) => {
      const sp = by.get(l.storeProductId)!;
      return { storeProductId: sp.id, quantity: l.quantity, title: sp.title ?? sp.product.title, unitPriceCents: sp.priceCents };
    });
  }

  /** Recovery link → the storefront restores the bag. Signed; works once or many times. */
  async recover(cartId: string, sig: string) {
    if (!verifyRecover(cartId, sig)) throw new BadRequestException('This link is not valid');
    const cart = await prisma.cart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Bag not found');
    if (cart.status === 'CONVERTED') return { status: cart.status, token: null, lines: [] };
    const now = new Date();
    if (cart.status === 'OPEN') {
      await prisma.cart.updateMany({ where: { id: cart.id, status: 'OPEN' }, data: { recoveredAt: cart.recoveredAt ?? now, lastActivityAt: now } });
    }
    const current = await this.price(cart.storeId, (cart.lines as Line[]).map((l) => ({ storeProductId: l.storeProductId, quantity: l.quantity })));
    return { status: cart.status, token: cart.status === 'OPEN' ? cart.token : null, lines: current.map((l) => ({ storeProductId: l.storeProductId, quantity: l.quantity })) };
  }

  /** Unsubscribe (signed link or RFC 8058 one-click POST). Idempotent. */
  async unsubscribe(storeId: string, hash: string, sig: string, reason: 'unsubscribe' | 'one_click' = 'unsubscribe') {
    if (!/^[a-f0-9]{64}$/.test(hash) || !verifyUnsubscribe(storeId, hash, sig)) throw new BadRequestException('This unsubscribe link is not valid');
    const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, name: true } });
    if (!store) throw new NotFoundException('Shop not found');
    await prisma.emailSuppression.upsert({
      where: { storeId_emailHash: { storeId, emailHash: hash } },
      create: { storeId, emailHash: hash, reason },
      update: {},
    });
    const open = await prisma.cart.findMany({ where: { storeId, emailHash: hash, status: 'OPEN' }, select: { id: true } });
    if (open.length) {
      await prisma.cart.updateMany({ where: { id: { in: open.map((c) => c.id) }, status: 'OPEN' }, data: { status: 'OPTED_OUT', consent: false, ...SCRUB } });
      await this.cancelQueued(open.map((c) => c.id), 'unsubscribed');
    }
    return { store: store.name };
  }

  async unsubscribeInfo(storeId: string, hash: string, sig: string) {
    const valid = /^[a-f0-9]{64}$/.test(hash) && verifyUnsubscribe(storeId, hash, sig);
    const store = valid ? await prisma.store.findUnique({ where: { id: storeId }, select: { name: true } }) : null;
    const done = valid ? !!(await prisma.emailSuppression.findUnique({ where: { storeId_emailHash: { storeId, emailHash: hash } } })) : false;
    return { valid: valid && !!store, store: store?.name ?? null, done };
  }

  private async cancelQueued(cartIds: string[], why: string) {
    await prisma.emailMessage.updateMany({ where: { cartId: { in: cartIds }, status: 'QUEUED' }, data: { status: 'CANCELLED', lastError: `not sent: ${why}` } });
  }

  /** Sweeper body (every CART_SWEEP_MS). Safe to run on several instances at once. */
  async sweep(now = new Date()) {
    const cfg = cartConfig();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const expired = await prisma.cart.updateMany({ where: { status: 'OPEN', lastActivityAt: { lt: ago(cfg.expireMs) } }, data: { status: 'EXPIRED', ...SCRUB } });
    const sendable = {
      status: 'OPEN' as const,
      consent: true,
      email: { not: null },
      itemCount: { gt: 0 },
      store: { cartRecovery: true, status: 'ACTIVE' as const, deletedAt: null, mailingAddress: { not: null } },
    };
    const due1 = await prisma.cart.findMany({
      where: { ...sendable, reminder1At: null, lastActivityAt: { lte: ago(cfg.reminder1Ms), gte: ago(cfg.firstReminderWindowMs) } },
      orderBy: { lastActivityAt: 'asc' }, take: 100, select: { id: true },
    });
    const due2 = await prisma.cart.findMany({
      where: { ...sendable, reminder1At: { not: null, lte: ago(cfg.minGapMs) }, reminder2At: null, lastActivityAt: { lte: ago(cfg.reminder2Ms) } },
      orderBy: { lastActivityAt: 'asc' }, take: 100, select: { id: true },
    });
    const out: { cartId: string; step: 1 | 2; result: string }[] = [];
    for (const c of due1) out.push({ cartId: c.id, step: 1, result: await this.remind(c.id, 1, now) });
    for (const c of due2) out.push({ cartId: c.id, step: 2, result: await this.remind(c.id, 2, now) });
    return { expired: expired.count, reminders: out };
  }

  /** One reminder step for one cart. Returns what happened (queued | already | converted | …). */
  async remind(cartId: string, step: 1 | 2, now = new Date()): Promise<string> {
    try {
      const cart = await prisma.cart.findUnique({ where: { id: cartId }, include: { store: true } });
      if (!cart || cart.status !== 'OPEN' || !cart.consent || !cart.email || !cart.emailHash) return 'not_open';
      if (!cart.store.cartRecovery || !cart.store.mailingAddress) return 'recovery_off';
      const field = step === 1 ? 'reminder1At' : 'reminder2At';
      if (cart[field]) return 'already';
      if (step === 2 && !cart.reminder1At) return 'not_due';

      const paid = await paidOrderFor(cart);
      if (paid) {
        await prisma.cart.updateMany({ where: { id: cart.id, status: 'OPEN' }, data: { status: 'CONVERTED', convertedAt: now, orderId: paid.id, ...SCRUB } });
        return 'converted';
      }
      if (await prisma.emailSuppression.findUnique({ where: { storeId_emailHash: { storeId: cart.storeId, emailHash: cart.emailHash } } })) {
        await prisma.cart.updateMany({ where: { id: cart.id, status: 'OPEN' }, data: { status: 'OPTED_OUT', consent: false, ...SCRUB } });
        return 'unsubscribed';
      }
      if (step === 1) {
        const cfg = cartConfig();
        const recent = await prisma.cart.findFirst({
          where: { storeId: cart.storeId, emailHash: cart.emailHash, id: { not: cart.id }, reminder1At: { gte: new Date(now.getTime() - cfg.perAddressWindowMs) }, emails: { some: {} } },
          select: { id: true },
        });
        if (recent) {
          // Already reminded this address this week: close this cart's sequence without sending
          await prisma.cart.updateMany({ where: { id: cart.id, reminder1At: null }, data: { reminder1At: now, reminder2At: now } });
          return 'capped';
        }
      }
      const lines = await this.price(cart.storeId, (cart.lines as Line[]).map((l) => ({ storeProductId: l.storeProductId, quantity: l.quantity })));
      if (!lines.length) {
        await prisma.cart.updateMany({ where: { id: cart.id, status: 'OPEN' }, data: { status: 'EXPIRED', ...SCRUB } });
        return 'unavailable';
      }
      const subtotal = lines.reduce((a, l) => a + l.unitPriceCents * l.quantity, 0);
      const urls = await DomainsService.storeUrls(cart.store);
      const shop = `${urls.origin}${urls.shopPath}`;
      const recoverUrl = `${shop}${shop.includes('?') ? '&' : '?'}recover=${cart.id}&t=${recoverSig(cart.id)}`;
      const unsubscribeUrl = `${apiPublicUrl()}/api/email/unsubscribe?s=${cart.storeId}&e=${cart.emailHash}&t=${unsubscribeSig(cart.storeId, cart.emailHash)}`;
      const etaRows = await prisma.storeProduct.findMany({ where: { id: { in: lines.map((l) => l.storeProductId) } }, select: { product: { select: { etaDaysMin: true, etaDaysMax: true } } } });
      const eta = etaRows.length ? { minDays: Math.max(...etaRows.map((r) => r.product.etaDaysMin)), maxDays: Math.max(...etaRows.map((r) => r.product.etaDaysMax)) } : null;
      const r = renderCartEmail(step, {
        store: { name: cart.store.name, shopUrl: shop, mailingAddress: cart.store.mailingAddress },
        cart: { id: cart.id, customerName: cart.customerName, currency: cart.currency, lines, subtotalCents: subtotal, consentAt: cart.consentAt },
        recoverUrl, unsubscribeUrl, eta,
      });
      const owner = await prisma.organizationMember.findFirst({ where: { organizationId: cart.store.organizationId, role: "owner" }, orderBy: { createdAt: "asc" }, include: { user: { select: { email: true } } } });
      const kind = step === 1 ? 'CART_REMINDER_1' : 'CART_REMINDER_2';
      let emailId: string | null = null;
      try {
        emailId = await prisma.$transaction(async (tx) => {
          const claim = await tx.cart.updateMany({ where: { id: cart.id, status: 'OPEN', [field]: null }, data: { [field]: now } });
          if (!claim.count) return null;
          const m = await tx.emailMessage.create({
            data: {
              kind, dedupeKey: `${kind}:${cart.id}`, storeId: cart.storeId, cartId: cart.id,
              to: cart.email!, from: fromHeader(cart.store.name), replyTo: owner?.user.email ?? null,
              subject: headerLine(r.subject), html: r.html, text: r.text,
              headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
            },
          });
          return m.id;
        });
      } catch (e: any) {
        if (e?.code === 'P2002') return 'already';
        throw e;
      }
      if (!emailId) return 'already';
      const q = await enqueueEmailSend(emailId);
      if (q.inline) await this.emails.send(emailId).catch(() => null);
      return 'queued';
    } catch (e: any) {
      this.logger.warn(`cart ${cartId} reminder ${step}: ${e?.message ?? e}`);
      return 'error';
    }
  }

  // ---------------- merchant ----------------

  private async ownStore(organizationId: string, storeId: string) {
    const s = await prisma.store.findFirst({ where: { id: storeId, organizationId, deletedAt: null } });
    if (!s) throw new NotFoundException('Store not found');
    return s;
  }

  async overview(organizationId: string, storeId: string) {
    const store = await this.ownStore(organizationId, storeId);
    const since = new Date(Date.now() - 30 * 86_400_000);
    const carts = await prisma.cart.findMany({
      where: { storeId, createdAt: { gte: since } },
      orderBy: { lastActivityAt: 'desc' },
      take: 100,
      include: { emails: { select: { id: true, kind: true, status: true, sentAt: true, lastError: true }, orderBy: { createdAt: 'asc' } } },
    });
    const all = await prisma.cart.groupBy({ by: ['status'], where: { storeId, createdAt: { gte: since } }, _count: true, _sum: { recoveredCents: true } });
    const sent = await prisma.emailMessage.count({ where: { storeId, kind: { in: ['CART_REMINDER_1', 'CART_REMINDER_2'] }, status: 'SENT', createdAt: { gte: since } } });
    const recovered = await prisma.cart.aggregate({ where: { storeId, createdAt: { gte: since }, recoveredCents: { not: null } }, _count: true, _sum: { recoveredCents: true } });
    const unsubscribed = await prisma.emailSuppression.count({ where: { storeId } });
    const cfg = cartConfig();
    return {
      settings: { enabled: store.cartRecovery, mailingAddress: store.mailingAddress, ready: store.cartRecovery && !!store.mailingAddress },
      timing: { reminder1Minutes: cfg.reminder1Ms / 60_000, reminder2Hours: cfg.reminder2Ms / 3_600_000, expireDays: cfg.expireMs / 86_400_000 },
      consentText: CART_CONSENT_TEXT,
      stats: {
        windowDays: 30,
        captured: all.reduce((a, g) => a + g._count, 0),
        byStatus: Object.fromEntries(all.map((g) => [g.status, g._count])),
        remindersSent: sent,
        recoveredOrders: recovered._count,
        recoveredCents: recovered._sum.recoveredCents ?? 0,
        unsubscribed,
      },
      carts: carts.map((c) => ({
        id: c.id,
        email: maskEmail(c.email),
        status: c.status,
        consent: c.consent,
        itemCount: c.itemCount,
        subtotalCents: c.subtotalCents,
        currency: c.currency,
        lastActivityAt: c.lastActivityAt,
        reminder1At: c.reminder1At,
        reminder2At: c.reminder2At,
        recoveredAt: c.recoveredAt,
        convertedAt: c.convertedAt,
        recoveredCents: c.recoveredCents,
        emails: c.emails,
      })),
    };
  }

  async updateSettings(organizationId: string, storeId: string, body: { enabled?: boolean; mailingAddress?: string | null }) {
    const current = await this.ownStore(organizationId, storeId);
    const addr = body.mailingAddress === undefined ? undefined : body.mailingAddress?.replace(/[\r\n]+/g, ', ').replace(/\s{2,}/g, ' ').trim().slice(0, 300) || null;
    if (body.enabled && (addr === null || (addr === undefined && !current.mailingAddress))) throw new BadRequestException('A mailing address is required to send reminders');
    const s = await prisma.store.update({
      where: { id: storeId },
      data: { ...(body.enabled !== undefined ? { cartRecovery: body.enabled } : {}), ...(addr !== undefined ? { mailingAddress: addr } : {}) },
    });
    if (s.cartRecovery === false) {
      const open = await prisma.cart.findMany({ where: { storeId, status: 'OPEN' }, select: { id: true } });
      if (open.length) await this.cancelQueued(open.map((c) => c.id), 'recovery_off');
    }
    return this.overview(organizationId, storeId);
  }
}
