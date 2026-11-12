import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { prisma, Prisma } from '@storeforge/db';
import { getPaymentProvider, isDefiniteRejection } from './index';

const MIN_TOPUP = 1000; // $10
const MAX_TOPUP = 500000; // $5,000
const REFUND_WINDOW_DAYS = 90;

function isUniqueViolation(e: unknown) {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/**
 * Ad Fuel wallet money movement. Top-ups are platform-account PaymentIntents;
 * the wallet is credited only from the verified payment_intent.succeeded webhook
 * (or instantly in stub mode). Unused, non-bonus fuel is refundable within 90 days.
 * UI, auto-reload and daily spend debits are Phase 1 slice 3.
 */
@Injectable()
export class FuelService {
  private readonly logger = new Logger(FuelService.name);

  async wallet(organizationId: string) {
    return prisma.adWallet.upsert({
      where: { organizationId },
      update: {},
      create: { organizationId },
    });
  }

  async summary(organizationId: string) {
    const w = await this.wallet(organizationId);
    const txns = await prisma.walletTxn.findMany({ where: { walletId: w.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { wallet: w, txns };
  }

  async startTopUp(organizationId: string, email: string, amountCents: number, requestId: string) {
    if (!Number.isInteger(amountCents) || amountCents < MIN_TOPUP || amountCents > MAX_TOPUP) {
      throw new BadRequestException(`Top-up must be between $${MIN_TOPUP / 100} and $${MAX_TOPUP / 100}`);
    }
    const provider = getPaymentProvider();
    const w = await this.wallet(organizationId);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const { customerId } = await provider.ensureCustomer({ organizationId, email, customerId: org.billingCustomerId });
    if (!org.billingCustomerId && provider.kind !== 'stub') {
      await prisma.organization.update({ where: { id: organizationId }, data: { billingCustomerId: customerId } });
    }
    const pi = await provider.createTopUpIntent({
      organizationId,
      walletId: w.id,
      customerId,
      amountCents,
      currency: w.currency,
      idempotencyKey: `sf-fuel-${w.id}-${requestId}`,
    });
    if (provider.kind === 'stub') {
      await this.creditTopUp({ paymentIntentId: pi.paymentIntentId, amountCents, walletId: w.id, provider: 'stub' });
    }
    return { paymentIntentId: pi.paymentIntentId, clientSecret: pi.clientSecret, status: pi.status, mode: provider.mode() };
  }

  /** Idempotent: a replayed webhook for the same PaymentIntent is a no-op. */
  async creditTopUp(o: { paymentIntentId: string; amountCents: number; walletId: string; provider: string; organizationId?: string }) {
    const w = await prisma.adWallet.findUnique({ where: { id: o.walletId } });
    if (!w) throw new NotFoundException('Wallet not found');
    if (o.organizationId && w.organizationId !== o.organizationId) {
      throw new BadRequestException('Wallet/organization mismatch');
    }
    const seen = await prisma.walletTxn.findFirst({ where: { kind: 'TOPUP', providerPaymentId: o.paymentIntentId } });
    if (seen) return { credited: false, duplicate: true };
    try {
      return await prisma.$transaction(async (tx) => {
        const txn = await tx.walletTxn.create({
          data: { walletId: w.id, kind: 'TOPUP', amountCents: o.amountCents, provider: o.provider, providerPaymentId: o.paymentIntentId },
        });
        await tx.adWallet.update({ where: { id: w.id }, data: { balanceCents: { increment: o.amountCents } } });
        return { credited: true, txnId: txn.id };
      });
    } catch (e) {
      if (isUniqueViolation(e)) return { credited: false, duplicate: true };
      throw e;
    }
  }

  async refundable(topupTxnId: string) {
    const t = await prisma.walletTxn.findUnique({ where: { id: topupTxnId } });
    if (!t || t.kind !== 'TOPUP') throw new NotFoundException('Top-up not found');
    const refunds = await prisma.walletTxn.aggregate({
      where: { kind: 'REFUND', refundOfId: t.id, status: { not: 'failed' } },
      _sum: { amountCents: true },
    });
    return { topup: t, remaining: t.amountCents + (refunds._sum.amountCents ?? 0) }; // refunds are negative
  }

  async refundTopUp(organizationId: string, topupTxnId: string, amountCents?: number) {
    const w = await this.wallet(organizationId);
    const { topup, remaining } = await this.refundable(topupTxnId);
    if (topup.walletId !== w.id) throw new NotFoundException('Top-up not found');
    if (Date.now() - topup.createdAt.getTime() > REFUND_WINDOW_DAYS * 86400000) {
      throw new BadRequestException(`Top-ups can be refunded for ${REFUND_WINDOW_DAYS} days`);
    }
    const amount = amountCents ?? Math.min(remaining, w.balanceCents);
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('Nothing left to refund');
    if (amount > remaining) throw new BadRequestException('More than the unrefunded part of this top-up');
    if (!topup.providerPaymentId) throw new BadRequestException('Top-up has no payment reference');

    // Reserve the fuel and persist the pending refund record in one transaction (balance can't go
    // below zero: guarded here and by the AdWallet_balance_nonnegative CHECK constraint).
    const txn = await prisma.$transaction(async (tx) => {
      const reserved = await tx.adWallet.updateMany({
        where: { id: w.id, balanceCents: { gte: amount } },
        data: { balanceCents: { decrement: amount } },
      });
      if (reserved.count !== 1) throw new BadRequestException('Only unspent fuel can be refunded');
      return tx.walletTxn.create({
        data: { walletId: w.id, kind: 'REFUND', amountCents: -amount, provider: topup.provider, refundOfId: topup.id, status: 'pending' },
      });
    });

    return this.submitRefund(txn.id);
  }

  /**
   * Sends (or re-sends) a pending REFUND txn to the provider. Same idempotency key every time,
   * plus a metadata lookup first, so a timed-out call can never create a second refund.
   * Fuel is restored ONLY when the refund is confirmed failed (provider status failed/canceled,
   * or a definitive 4xx rejection). Any other error leaves the txn "unknown" for the reconciler.
   */
  async submitRefund(txnId: string) {
    const txn = await prisma.walletTxn.findUniqueOrThrow({ where: { id: txnId } });
    const topup = txn.refundOfId ? await prisma.walletTxn.findUnique({ where: { id: txn.refundOfId } }) : null;
    if (!topup?.providerPaymentId) throw new BadRequestException('Top-up has no payment reference');
    const amount = -txn.amountCents;
    // Processor cost deduction (blueprint: "minus processor costs"). Defaults to 0 until Jeff sets it.
    const feeBps = Math.max(0, Number(process.env.FUEL_REFUND_FEE_BPS ?? 0) || 0);
    const feeFixed = Math.max(0, Number(process.env.FUEL_REFUND_FEE_FIXED_CENTS ?? 0) || 0);
    const cardRefund = Math.max(0, amount - Math.round((amount * feeBps) / 10000) - feeFixed);
    const provider = getPaymentProvider();
    try {
      let r: { refundId: string; status: string } | null = null;
      if (cardRefund <= 0) r = { refundId: `none_${txn.id}`, status: 'succeeded' };
      if (!r) r = await provider.findRefundByMetadata(topup.providerPaymentId, 'walletTxnId', txn.id);
      if (!r) {
        r = await provider.refundPayment({
          paymentId: topup.providerPaymentId,
          amountCents: cardRefund,
          idempotencyKey: `sf-fuelrefund-${txn.id}`,
          metadata: { kind: 'ad_fuel_refund', walletTxnId: txn.id, walletId: txn.walletId },
        });
      }
      const status = r.status === 'failed' || r.status === 'canceled' ? 'failed' : r.status === 'succeeded' ? 'succeeded' : 'pending';
      await prisma.walletTxn.update({ where: { id: txn.id }, data: { providerRefundId: r.refundId, status: status === 'failed' ? 'pending' : status, lastError: null, reconciledAt: new Date() } });
      if (status === 'failed') await this.reverseFailedRefund(r.refundId);
      return { refundId: r.refundId, status, fuelDebitedCents: amount, cardRefundCents: cardRefund };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isDefiniteRejection(e)) {
        // Stripe refused it, so no refund exists: safe to give the fuel back (exactly once).
        const ref = `rejected_${txn.id}`;
        await prisma.walletTxn.update({ where: { id: txn.id }, data: { providerRefundId: txn.providerRefundId ?? ref, lastError: msg.slice(0, 500) } });
        await this.reverseFailedRefund(txn.providerRefundId ?? ref);
        throw new BadRequestException(`Refund was declined: ${msg}`);
      }
      // Timeout / network / 5xx: the refund may exist. Keep the fuel reserved; reconciler decides.
      await prisma.walletTxn.update({ where: { id: txn.id }, data: { status: 'unknown', lastError: msg.slice(0, 500), reconciledAt: new Date() } });
      this.logger.warn(`Fuel refund ${txn.id} outcome unknown (${msg}); reconciler will confirm`);
      return { refundId: txn.providerRefundId, status: 'unknown' as const, fuelDebitedCents: amount, cardRefundCents: cardRefund };
    }
  }

  /**
   * Reconciler: refunds still pending/unknown after `olderThanMs` are checked against the provider.
   *  - known refund id → fetch its status
   *  - no id yet       → look it up by metadata; if Stripe has none, re-submit with the same key
   */
  async reconcilePendingRefunds(olderThanMs = 5 * 60_000, now = new Date()) {
    const cutoff = new Date(now.getTime() - olderThanMs);
    const stuck = await prisma.walletTxn.findMany({
      where: { kind: 'REFUND', status: { in: ['pending', 'unknown'] }, OR: [{ reconciledAt: null }, { reconciledAt: { lt: cutoff } }], createdAt: { lt: cutoff } },
      take: 50,
    });
    const provider = getPaymentProvider();
    const out: { txnId: string; result: string }[] = [];
    for (const t of stuck) {
      try {
        if (t.providerRefundId && !t.providerRefundId.startsWith('none_') && !t.providerRefundId.startsWith('rejected_')) {
          const r = await provider.getRefund(t.providerRefundId);
          await prisma.walletTxn.update({ where: { id: t.id }, data: { reconciledAt: now } });
          if (r) await this.applyRefundStatus(r.refundId, r.status);
          out.push({ txnId: t.id, result: r?.status ?? 'not_found' });
        } else {
          const r = await this.submitRefund(t.id);
          out.push({ txnId: t.id, result: String(r.status) });
        }
      } catch (e) {
        out.push({ txnId: t.id, result: `error: ${e instanceof Error ? e.message : e}` });
      }
    }
    return out;
  }

  /** refund.updated/refund.failed → succeeded or failed. Idempotent. */
  async applyRefundStatus(refundId: string, status: string) {
    const txn = await prisma.walletTxn.findFirst({ where: { kind: 'REFUND', providerRefundId: refundId } });
    if (!txn) return { matched: false };
    if (status === 'failed' || status === 'canceled') return this.reverseFailedRefund(refundId);
    if (status === 'succeeded' && (txn.status === 'pending' || txn.status === 'unknown')) {
      await prisma.walletTxn.update({ where: { id: txn.id }, data: { status: 'succeeded' } });
    }
    return { matched: true };
  }

  async reverseFailedRefund(refundId: string) {
    const txn = await prisma.walletTxn.findFirst({ where: { kind: 'REFUND', providerRefundId: refundId } });
    if (!txn) return { matched: false };
    const seen = await prisma.walletTxn.findFirst({ where: { kind: 'ADJUST', providerRefundId: refundId } });
    if (seen) return { matched: true, reversed: false, duplicate: true };
    try {
      await prisma.$transaction(async (tx) => {
        await tx.walletTxn.create({
          data: { walletId: txn.walletId, kind: 'ADJUST', amountCents: -txn.amountCents, provider: txn.provider, providerRefundId: refundId, refundOfId: txn.refundOfId },
        });
        await tx.walletTxn.update({ where: { id: txn.id }, data: { status: 'failed' } });
        await tx.adWallet.update({ where: { id: txn.walletId }, data: { balanceCents: { increment: -txn.amountCents } } });
      });
      return { matched: true, reversed: true };
    } catch (e) {
      if (isUniqueViolation(e)) return { matched: true, reversed: false, duplicate: true };
      throw e;
    }
  }
}
