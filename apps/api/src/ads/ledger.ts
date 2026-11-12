import { NotFoundException } from '@nestjs/common';
import { prisma, Prisma, type AdWallet } from '@storeforge/db';
import { fuelEvents } from './fuel-events';

type Tx = Prisma.TransactionClient;

/**
 * Every Ad Fuel balance change runs inside a transaction that first takes this row lock, so
 * concurrent top-ups, debits, refunds and reloads on one wallet are serialized and each ledger
 * entry records the exact balance after it. The CHECK constraints are the last line of defence.
 */
export async function lockWallet(tx: Tx, walletId: string): Promise<AdWallet> {
  const rows = await tx.$queryRaw<AdWallet[]>`SELECT * FROM "AdWallet" WHERE "id" = ${walletId} FOR UPDATE`;
  if (!rows[0]) throw new NotFoundException('Wallet not found');
  return rows[0];
}

export const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Credits a succeeded top-up exactly once per PaymentIntent (unique [kind, providerPaymentId]).
 * Saves the card for auto-reload when the payment carried one, and releases an in-flight reload.
 */
export async function creditTopUp(o: {
  paymentIntentId: string;
  amountCents: number;
  walletId: string;
  provider: string;
  organizationId?: string;
  source?: 'manual' | 'auto';
  paymentMethodId?: string | null;
  paymentMethodLabel?: string | null;
}) {
  const seen = await prisma.walletTxn.findFirst({ where: { kind: 'TOPUP', providerPaymentId: o.paymentIntentId } });
  if (seen) return { credited: false, duplicate: true as const, txnId: seen.id };
  try {
    const r = await prisma.$transaction(async (tx) => {
      const w = await lockWallet(tx, o.walletId);
      if (o.organizationId && w.organizationId !== o.organizationId) throw new Error('Wallet/organization mismatch');
      const balanceAfter = w.balanceCents + o.amountCents;
      const txn = await tx.walletTxn.create({
        data: {
          walletId: w.id, kind: 'TOPUP', amountCents: o.amountCents, provider: o.provider, providerPaymentId: o.paymentIntentId,
          source: o.source ?? 'manual', balanceAfterCents: balanceAfter, bonusAfterCents: w.bonusCents,
        },
      });
      await tx.adWallet.update({
        where: { id: w.id },
        data: {
          balanceCents: balanceAfter,
          lowFuelAt: null,
          ...(o.paymentMethodId ? { paymentMethodId: o.paymentMethodId, paymentMethodLabel: o.paymentMethodLabel ?? null } : {}),
          ...(o.source === 'auto' ? { reloadInFlight: false, reloadFailures: 0, reloadLastError: null } : {}),
        },
      });
      return { credited: true as const, txnId: txn.id };
    });
    fuelEvents.emit('added', o.walletId);
    return r;
  } catch (e) {
    if (isUniqueViolation(e)) return { credited: false, duplicate: true as const };
    throw e;
  }
}
