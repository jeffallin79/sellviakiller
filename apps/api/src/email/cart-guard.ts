import { prisma } from '@storeforge/db';
import { emailHash } from './links';

export const CART_KINDS = new Set(['CART_REMINDER_1', 'CART_REMINDER_2']);

/**
 * Send-time check for abandoned-cart reminders. Returns why it must NOT go out, or null.
 * Order emails (transactional) are never blocked here.
 */
export async function cartEmailBlocker(m: { kind: string; cartId: string | null; storeId: string | null; to: string }): Promise<string | null> {
  if (!CART_KINDS.has(m.kind)) return null;
  if (!m.cartId || !m.storeId) return 'cart_missing';
  const cart = await prisma.cart.findUnique({ where: { id: m.cartId }, include: { store: { select: { cartRecovery: true, status: true, deletedAt: true } } } });
  if (!cart) return 'cart_missing';
  if (cart.status !== 'OPEN') return `cart_${cart.status.toLowerCase()}`;
  if (!cart.consent || !cart.email) return 'no_consent';
  if (emailHash(cart.email) !== emailHash(m.to)) return 'email_changed';
  if (!cart.store.cartRecovery || cart.store.status !== 'ACTIVE' || cart.store.deletedAt) return 'recovery_off';
  const sup = await prisma.emailSuppression.findUnique({ where: { storeId_emailHash: { storeId: m.storeId, emailHash: emailHash(m.to) } } });
  if (sup) return 'unsubscribed';
  return null;
}
