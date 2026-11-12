import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { prisma, Prisma } from '@storeforge/db';
import { getPaymentProvider } from './index';

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

    // Processor cost deduction (blueprint: "minus processor costs"). Defaults to 0 until Jeff sets it.
    const feeBps = Math.max(0, Number(process.env.FUEL_REFUND_FEE_BPS ?? 0) || 0);
    const feeFixed = Math.max(0, Number(process.env.FUEL_REFUND_FEE_FIXED_CENTS ?? 0) || 0);
    const cardRefund = Math.max(0, amount - Math.round((amount * feeBps) / 10000) - feeFixed);

    // Reserve the fuel first (atomic, can't go below zero) so spend and refund can't race.
    const reserved = await prisma.adWallet.updateMany({
      where: { id: w.id, balanceCents: { gte: amount } },
      data: { balanceCents: { decrement: amount } },
    });
    if (reserved.count !== 1) throw new BadRequestException('Only unspent fuel can be refunded');
    const txn = await prisma.walletTxn.create({
      data: { walletId: w.id, kind: 'REFUND', amountCents: -amount, provider: topup.provider, refundOfId: topup.id, status: 'pending' },
    });

    const provider = getPaymentProvider();
    try {
      const r =
        cardRefund > 0
          ? await provider.refundPayment({
              paymentId: topup.providerPaymentId,
              amountCents: cardRefund,
              idempotencyKey: `sf-fuelrefund-${txn.id}`,
              metadata: { kind: 'ad_fuel_refund', walletTxnId: txn.id, walletId: w.id },
            })
          : { refundId: `none_${txn.id}`, status: 'succeeded' };
      const status = r.status === 'failed' || r.status === 'canceled' ? 'failed' : r.status === 'succeeded' ? 'succeeded' : 'pending';
      await prisma.walletTxn.update({ where: { id: txn.id }, data: { providerRefundId: r.refundId, status } });
      if (status === 'failed') await this.reverseFailedRefund(r.refundId);
      return { refundId: r.refundId, status, fuelDebitedCents: amount, cardRefundCents: cardRefund };
    } catch (e) {
      // Provider rejected the refund: give the fuel back.
      await prisma.$transaction([
        prisma.walletTxn.update({ where: { id: txn.id }, data: { status: 'failed' } }),
        prisma.adWallet.update({ where: { id: w.id }, data: { balanceCents: { increment: amount } } }),
      ]);
      throw e;
    }
  }

  /** refund.updated/refund.failed → succeeded or failed. Idempotent. */
  async applyRefundStatus(refundId: string, status: string) {
    const txn = await prisma.walletTxn.findFirst({ where: { kind: 'REFUND', providerRefundId: refundId } });
    if (!txn) return { matched: false };
    if (status === 'failed' || status === 'canceled') return this.reverseFailedRefund(refundId);
    if (status === 'succeeded' && txn.status === 'pending') {
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
