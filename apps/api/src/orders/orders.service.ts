import { Injectable, NotFoundException, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { prisma, OrderStatus } from '@storeforge/db';
import type { CheckoutInput } from '@storeforge/shared';
import { getPaymentProvider, platformFeeCents as computePlatformFee } from '../payments';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { enqueueRouteFulfillment } from '../jobs/queues';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(private readonly fulfillment: FulfillmentService) {}

  async checkout(input: CheckoutInput) {
    const store = await prisma.store.findFirst({
      where: { slug: input.storeSlug, deletedAt: null, status: 'ACTIVE' },
      include: { organization: true },
    });
    if (!store) throw new NotFoundException('Store not found');
    const provider = getPaymentProvider();
    const org = store.organization;
    if (provider.kind !== 'stub' && (!org.payoutAccountId || !org.payoutChargesEnabled || org.payoutProvider !== provider.kind)) {
      throw new ConflictException("This store isn't set up to take payments yet.");
    }

    const storeProducts = await prisma.storeProduct.findMany({
      where: {
        id: { in: input.lines.map((l) => l.storeProductId) },
        storeId: store.id,
        active: true,
        deletedAt: null,
      },
      include: { product: true },
    });
    if (storeProducts.length !== input.lines.length) {
      throw new BadRequestException('One or more products unavailable');
    }

    const byId = new Map(storeProducts.map((sp) => [sp.id, sp]));
    let subtotalCents = 0;
    const lineData = input.lines.map((l) => {
      const sp = byId.get(l.storeProductId)!;
      subtotalCents += sp.priceCents * l.quantity;
      return {
        storeProductId: sp.id,
        title: sp.title ?? sp.product.title,
        sku: sp.product.sku,
        quantity: l.quantity,
        unitPriceCents: sp.priceCents,
        unitCostCents: sp.product.costCents,
      };
    });

    const shippingCents = subtotalCents >= 5000 ? 0 : 499;
    const totalCents = subtotalCents + shippingCents;
    const platformFeeCents = computePlatformFee(totalCents);

    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        status: OrderStatus.PENDING_PAYMENT,
        customerEmail: input.email,
        customerName: input.name,
        shippingLine1: input.shippingAddress.line1,
        shippingLine2: input.shippingAddress.line2,
        shippingCity: input.shippingAddress.city,
        shippingState: input.shippingAddress.state,
        shippingPostalCode: input.shippingAddress.postalCode,
        shippingCountry: input.shippingAddress.country,
        subtotalCents,
        shippingCents,
        totalCents,
        platformFeeCents,
        provider: provider.kind,
        payoutAccountId: provider.kind === 'stub' ? null : org.payoutAccountId,
        lines: { create: lineData },
      },
      include: { lines: true },
    });

    const root =
      process.env.STOREFRONT_URL ??
      `http://${store.slug}.${process.env.NEXT_PUBLIC_STOREFRONT_ROOT_DOMAIN ?? 'storeforge.local'}:3000`;
    const successUrl = `${root}/checkout/complete?orderId=${order.id}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${root}/s/${store.slug}?checkout=cancelled`;

    const pay = await provider.createOrderCheckout({
      orderId: order.id,
      storeSlug: store.slug,
      currency: order.currency,
      customerEmail: input.email,
      lines: lineData.map((l) => ({ name: l.title, unitAmountCents: l.unitPriceCents, quantity: l.quantity })),
      shippingCents,
      destinationAccountId: org.payoutAccountId ?? 'stub',
      applicationFeeCents: platformFeeCents,
      successUrl,
      cancelUrl,
    });
    await prisma.order.update({ where: { id: order.id }, data: { providerCheckoutId: pay.checkoutId } });

    // Stub path: mark paid immediately when no Stripe keys (demo)
    if (provider.kind === 'stub') {
      await this.markPaid(order.id, `stub_payment_${order.id.slice(-8)}`, 'stub');
      return {
        order: await this.get(order.id),
        checkoutUrl: pay.url,
        mode: 'stub',
        message: 'Stub checkout — order marked PAID, no card charged. Set STRIPE_* for real Checkout.',
      };
    }

    // Stripe: the order turns PAID only from the verified checkout.session.completed webhook.
    return {
      order,
      checkoutUrl: pay.url,
      mode: provider.mode(),
      platformFeeCents,
    };
  }

  /** Webhook path: checks amount + currency against the order before marking it paid. */
  async markProviderPaid(
    orderId: string,
    p: { provider: string; paymentId: string; checkoutId?: string; amountCents?: number; currency?: string },
  ): Promise<string> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      this.logger.warn(`Paid event for unknown order ${orderId}`);
      return 'order_not_found';
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) return 'order_already_processed';
    if (p.checkoutId && order.providerCheckoutId && order.providerCheckoutId !== p.checkoutId) {
      this.logger.error(`Order ${orderId}: checkout id mismatch (${p.checkoutId})`);
      return 'checkout_mismatch';
    }
    if (
      (p.amountCents != null && p.amountCents !== order.totalCents) ||
      (p.currency && p.currency.toUpperCase() !== order.currency.toUpperCase())
    ) {
      this.logger.error(`Order ${orderId}: paid ${p.amountCents} ${p.currency} but expected ${order.totalCents} ${order.currency}`);
      return 'amount_mismatch';
    }
    await this.markPaid(orderId, p.paymentId, p.provider, p.checkoutId);
    return 'order_paid';
  }

  async markPaymentFailed(orderId: string, status: 'FAILED' | 'CANCELLED') {
    return prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { status },
    });
  }

  async markPaid(orderId: string, providerPaymentId: string, provider = 'stub', providerCheckoutId?: string) {
    const existing = await prisma.order.findUnique({ where: { id: orderId } });
    if (!existing) throw new NotFoundException('Order not found');
    // Do not regress SHIPPED/DELIVERED/etc. back to PAID (idempotent for already-paid).
    if (existing.status !== OrderStatus.PENDING_PAYMENT) {
      return existing;
    }

    const order = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.PAID,
        provider,
        providerPaymentId,
        ...(providerCheckoutId ? { providerCheckoutId } : {}),
      },
    });

    const q = await enqueueRouteFulfillment(orderId);
    if (q.inline) {
      await this.fulfillment.routeOrder(orderId);
    }
    return order;
  }

  async listForStore(storeId: string) {
    return prisma.order.findMany({
      where: { storeId },
      include: {
        lines: true,
        fulfillment: true,
        trackingEvents: { orderBy: { occurredAt: 'desc' }, take: 10 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForAccount(organizationId: string) {
    return prisma.order.findMany({
      where: { store: { organizationId } },
      include: {
        store: true,
        lines: true,
        fulfillment: true,
        trackingEvents: { orderBy: { occurredAt: 'desc' }, take: 5 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(orderId: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        lines: true,
        fulfillment: true,
        trackingEvents: { orderBy: { occurredAt: 'asc' } },
        store: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /** Merchant-scoped order fetch — never returns another org's order (or PII). */
  async getForAccount(organizationId: string, orderId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, store: { organizationId } },
      include: {
        lines: true,
        fulfillment: true,
        trackingEvents: { orderBy: { occurredAt: 'asc' } },
        store: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }
}
