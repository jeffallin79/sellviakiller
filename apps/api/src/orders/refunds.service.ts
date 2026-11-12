import { Injectable, BadRequestException, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { prisma, Prisma, OrderStatus } from '@storeforge/db';
import { getPaymentProvider, isDefiniteRejection } from '../payments';
import { EmailService } from '../email/email.service';

const REFUNDABLE: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.AWAITING_MERCHANT_APPROVAL,
  OrderStatus.FULFILLMENT_SUBMITTED,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

/**
 * Storefront order refunds. Stripe: a Refund on the destination charge with reverse_transfer, so the
 * money comes back out of the merchant's connected account. The amount is reserved on the order
 * first (can't over-refund under concurrency); the customer email goes out once the refund succeeds.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);
  constructor(private readonly emails: EmailService) {}

  async create(organizationId: string, orderId: string, input: { amountCents?: number; reason?: string; requestId: string }) {
    const order = await prisma.order.findFirst({ where: { id: orderId, store: { organizationId } } });
    if (!order) throw new NotFoundException('Order not found');
    const existing = await prisma.orderRefund.findUnique({ where: { orderId_requestId: { orderId, requestId: input.requestId } } });
    if (existing) return existing; // idempotent retry of the same request
    if (!REFUNDABLE.includes(order.status)) throw new BadRequestException('Only paid orders can be refunded');
    if (!order.providerPaymentId) throw new BadRequestException('This order has no payment to refund');
    const remaining = order.totalCents - order.refundedCents;
    const amount = input.amountCents ?? remaining;
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('Nothing left to refund');
    if (amount > remaining) throw new BadRequestException(`At most ${remaining} cents can still be refunded`);

    let refund;
    try {
      refund = await prisma.$transaction(async (tx) => {
        const reserved = await tx.order.updateMany({
          where: { id: orderId, refundedCents: { lte: order.totalCents - amount } },
          data: { refundedCents: { increment: amount } },
        });
        if (reserved.count !== 1) throw new ConflictException('Another refund changed this order; reload and try again');
        return tx.orderRefund.create({
          data: { orderId, amountCents: amount, reason: input.reason?.slice(0, 500), requestId: input.requestId, provider: order.provider, status: 'pending' },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return prisma.orderRefund.findUniqueOrThrow({ where: { orderId_requestId: { orderId, requestId: input.requestId } } });
      }
      throw e;
    }
    return this.submit(refund.id);
  }

  async submit(refundId: string) {
    const refund = await prisma.orderRefund.findUniqueOrThrow({ where: { id: refundId }, include: { order: true } });
    const provider = getPaymentProvider();
    try {
      const r =
        (await provider.findRefundByMetadata(refund.order.providerPaymentId!, 'orderRefundId', refund.id)) ??
        (await provider.refundPayment({
          paymentId: refund.order.providerPaymentId!,
          amountCents: refund.amountCents,
          idempotencyKey: `sf-orderrefund-${refund.id}`,
          metadata: { kind: 'store_order_refund', orderId: refund.orderId, orderRefundId: refund.id },
          reverseTransfer: refund.order.provider !== 'stub',
        }));
      await prisma.orderRefund.update({ where: { id: refund.id }, data: { providerRefundId: r.refundId } });
      return this.applyStatus({ refundId: r.refundId, status: r.status, orderRefundId: refund.id });
    } catch (e) {
      if (isDefiniteRejection(e)) {
        await this.release(refund.id, 'failed');
        throw new BadRequestException(`Refund was declined: ${e instanceof Error ? e.message : e}`);
      }
      this.logger.warn(`Order refund ${refund.id} outcome unknown: ${e instanceof Error ? e.message : e}`);
      return prisma.orderRefund.update({ where: { id: refund.id }, data: { status: 'unknown' } });
    }
  }

  /**
   * Webhook (refund.created/updated/failed with metadata.kind = store_order_refund) and the submit
   * path both land here. Idempotent: each transition is a conditional update.
   */
  async applyStatus(p: { refundId: string; status: string; orderRefundId?: string | null }) {
    let refund =
      (await prisma.orderRefund.findUnique({ where: { providerRefundId: p.refundId } })) ??
      (p.orderRefundId ? await prisma.orderRefund.findUnique({ where: { id: p.orderRefundId } }) : null);
    if (!refund) return null;
    if (!refund.providerRefundId) refund = await prisma.orderRefund.update({ where: { id: refund.id }, data: { providerRefundId: p.refundId } });

    if (p.status === 'succeeded') {
      const t = await prisma.orderRefund.updateMany({ where: { id: refund.id, status: { in: ['pending', 'unknown'] } }, data: { status: 'succeeded' } });
      if (t.count === 1) {
        const order = await prisma.order.findUniqueOrThrow({ where: { id: refund.orderId } });
        if (order.refundedCents >= order.totalCents) {
          await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.REFUNDED } });
        }
        await this.emails.orderEvent('ORDER_REFUNDED', refund.orderId, { refundId: refund.id, refundAmountCents: refund.amountCents });
      }
    } else if (p.status === 'pending' || p.status === 'requires_action') {
      // Found on Stripe after an unknown outcome: it exists, it just hasn't settled.
      await prisma.orderRefund.updateMany({ where: { id: refund.id, status: 'unknown' }, data: { status: 'pending' } });
    } else if (p.status === 'failed' || p.status === 'canceled') {
      await this.release(refund.id, p.status);
    }
    return prisma.orderRefund.findUniqueOrThrow({ where: { id: refund.id } });
  }

  /**
   * Gives the reserved amount back exactly once. A refund can also fail AFTER it succeeded
   * (e.g. the card was closed); then the order is flagged so the merchant pays the customer another way.
   */
  private async release(id: string, status: string) {
    await prisma.$transaction(async (tx) => {
      const r = await tx.orderRefund.findUniqueOrThrow({ where: { id } });
      const t = await tx.orderRefund.updateMany({ where: { id, status: { in: ['pending', 'unknown', 'succeeded'] } }, data: { status } });
      if (t.count !== 1) return;
      const o = await tx.order.update({ where: { id: r.orderId }, data: { refundedCents: { decrement: r.amountCents } } });
      if (r.status === 'succeeded') {
        await tx.order.update({
          where: { id: o.id },
          data: { flag: 'refund_failed', flagDetail: `Refund of ${r.amountCents} cents failed after it was sent; the customer hasn't been paid back`, flaggedAt: new Date() },
        });
      }
    });
  }

  list(organizationId: string, orderId: string) {
    return prisma.orderRefund.findMany({ where: { orderId, order: { store: { organizationId } } }, orderBy: { createdAt: 'desc' } });
  }
}
