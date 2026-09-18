import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { prisma, OrderStatus } from '@storeforge/db';
import type { CheckoutInput } from '@storeforge/shared';
import { createSquareCheckout } from '../billing/square.client';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { enqueueRouteFulfillment } from '../jobs/queues';

@Injectable()
export class OrdersService {
  constructor(private readonly fulfillment: FulfillmentService) {}

  async checkout(input: CheckoutInput) {
    const store = await prisma.store.findFirst({
      where: { slug: input.storeSlug, deletedAt: null, status: 'ACTIVE' },
    });
    if (!store) throw new NotFoundException('Store not found');

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
    const feeBps = Number(process.env.SQUARE_PLATFORM_FEE_BPS ?? 100);
    const platformFeeCents = Math.round((totalCents * feeBps) / 10000);

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
        lines: { create: lineData },
      },
      include: { lines: true },
    });

    const root =
      process.env.STOREFRONT_URL ??
      `http://${store.slug}.${process.env.NEXT_PUBLIC_STOREFRONT_ROOT_DOMAIN ?? 'storeforge.local'}:3000`;
    const redirectUrl = `${root}/checkout/complete`;

    const pay = await createSquareCheckout({
      amountCents: totalCents,
      currency: 'USD',
      orderId: order.id,
      redirectUrl,
      note: `Order ${order.id} @ ${store.slug}`,
    });

    // Stub path: mark paid immediately when no Square keys (demo)
    if (!process.env.SQUARE_ACCESS_TOKEN) {
      await this.markPaid(order.id, `stub_payment_${order.id.slice(-8)}`);
      return {
        order: await this.get(order.id),
        checkoutUrl: pay.url,
        mode: 'stub',
        message: 'Stub checkout — order marked PAID. Configure SQUARE_* for live Payment Links.',
      };
    }

    return {
      order,
      checkoutUrl: pay.url,
      mode: pay.mode ?? 'sandbox',
      platformFeeCents,
    };
  }

  async markPaid(orderId: string, squarePaymentId: string) {
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
        squarePaymentId,
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
