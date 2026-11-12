import { prisma, OrderStatus, Prisma } from '@storeforge/db';
import { CART_CONSENT_TEXT } from '@storeforge/shared';
import { emailHash, normEmail } from '../email/links';

/**
 * Cart ↔ order hooks used by OrdersService. Stateless (prisma only) so the orders module doesn't
 * depend on the carts module. Every write is conditional on status OPEN, so replays are no-ops.
 */

const SCRUB = { email: null, customerName: null } as const;

/** Checkout started: link the cart to the order. A shopper who ticked the box only at the final step still gets a row. */
export async function cartCheckoutStarted(
  storeId: string,
  input: { cartToken?: string; cartConsent?: boolean; email: string; name: string },
  order: { id: string; currency: string; subtotalCents: number; lines: { storeProductId: string; quantity: number; title: string; unitPriceCents: number }[] },
) {
  if (!input.cartToken) return;
  try {
    const lines = order.lines.map((l) => ({ storeProductId: l.storeProductId, quantity: l.quantity, title: l.title, unitPriceCents: l.unitPriceCents }));
    const itemCount = lines.reduce((a, l) => a + l.quantity, 0);
    const existing = await prisma.cart.findUnique({ where: { storeId_token: { storeId, token: input.cartToken } } });
    const now = new Date();
    if (existing) {
      if (existing.status !== 'OPEN') return;
      const consent = input.cartConsent ?? existing.consent;
      const email = normEmail(input.email);
      const suppressed = consent && (await prisma.emailSuppression.findUnique({ where: { storeId_emailHash: { storeId, emailHash: emailHash(email) } } }));
      await prisma.cart.updateMany({
        where: { id: existing.id, status: 'OPEN' },
        data: {
          orderId: order.id,
          lines: lines as Prisma.InputJsonValue,
          itemCount,
          subtotalCents: order.subtotalCents,
          currency: order.currency,
          lastActivityAt: now,
          ...(consent && !suppressed
            ? { consent: true, email, emailHash: emailHash(email), customerName: input.name, consentAt: existing.consent && existing.consentAt ? existing.consentAt : now, consentText: CART_CONSENT_TEXT }
            : { consent: false, consentAt: null, consentText: null, ...SCRUB }),
        },
      });
      return;
    }
    if (!input.cartConsent) return; // no consent → we keep nothing about an unpaid bag
    const email = normEmail(input.email);
    if (await prisma.emailSuppression.findUnique({ where: { storeId_emailHash: { storeId, emailHash: emailHash(email) } } })) return;
    await prisma.cart
      .create({
        data: {
          storeId, token: input.cartToken, email, emailHash: emailHash(email), customerName: input.name,
          lines: lines as Prisma.InputJsonValue, itemCount, subtotalCents: order.subtotalCents, currency: order.currency,
          consent: true, consentAt: now, consentText: CART_CONSENT_TEXT, lastActivityAt: now, orderId: order.id,
        },
      })
      .catch((e: any) => { if (e?.code !== 'P2002') throw e; });
  } catch {
    /* never break checkout over a reminder */
  }
}

/**
 * Order paid → close its cart and any other open cart from the same address at this store, so
 * nobody gets "you left something" after buying. Revenue counts as recovered only when a
 * reminder had actually been delivered before the order was placed.
 */
export async function cartOrderPaid(orderId: string) {
  try {
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, storeId: true, customerEmail: true, createdAt: true, totalCents: true } });
    if (!o) return [];
    const carts = await prisma.cart.findMany({
      where: { storeId: o.storeId, status: 'OPEN', OR: [{ orderId: o.id }, { emailHash: emailHash(o.customerEmail) }] },
      include: { emails: { where: { status: 'SENT' }, select: { sentAt: true } } },
    });
    const now = new Date();
    const closed: string[] = [];
    for (const c of carts) {
      const reminded = c.emails.some((e) => e.sentAt && e.sentAt <= o.createdAt);
      const r = await prisma.cart.updateMany({
        where: { id: c.id, status: 'OPEN' },
        data: { status: 'CONVERTED', convertedAt: now, orderId: o.id, recoveredCents: reminded ? o.totalCents : null, ...SCRUB },
      });
      if (r.count) closed.push(c.id);
    }
    // Anything still queued for these carts is cancelled at send time by cartEmailBlocker; do it now too.
    if (closed.length) {
      await prisma.emailMessage.updateMany({
        where: { cartId: { in: closed }, status: 'QUEUED' },
        data: { status: 'CANCELLED', lastError: 'not sent: cart_converted' },
      });
    }
    return closed;
  } catch {
    return [];
  }
}

/** Has this cart's shopper paid for an order here since the cart started? */
export async function paidOrderFor(cart: { storeId: string; orderId: string | null; emailHash: string | null; email: string | null; createdAt: Date }) {
  const or: Prisma.OrderWhereInput[] = [];
  if (cart.orderId) or.push({ id: cart.orderId });
  if (cart.email) or.push({ customerEmail: { equals: cart.email, mode: 'insensitive' }, createdAt: { gte: cart.createdAt } });
  if (!or.length) return null;
  return prisma.order.findFirst({
    where: { storeId: cart.storeId, OR: or, status: { notIn: [OrderStatus.PENDING_PAYMENT, OrderStatus.FAILED, OrderStatus.CANCELLED] } },
    select: { id: true },
  });
}
