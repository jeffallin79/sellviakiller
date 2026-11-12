import { Injectable, NotFoundException, BadRequestException, ConflictException, Logger } from '@nestjs/common';

/**
 * A paid event that doesn't match the order (amount, currency or checkout id). The order stays
 * PENDING_PAYMENT and gets flagged; the webhook is left unprocessed and answered non-2xx so Stripe
 * keeps retrying while someone looks. Never silently dropped.
 */
export class PaymentMismatchError extends ConflictException {
  constructor(readonly orderId: string, readonly organizationId: string | null, readonly detail: string) {
    super(`Payment does not match order ${orderId}: ${detail}`);
  }
}
import { prisma, OrderStatus } from '@storeforge/db';
import type { CheckoutInput } from '@storeforge/shared';
import { getPaymentProvider, platformFeeCents as computePlatformFee } from '../payments';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { enqueueRouteFulfillment } from '../jobs/queues';
import { EmailService } from '../email/email.service';
import { DomainsService } from '../domains/domains.service';
import { ConversionsService } from '../ads/conversions.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  /** Stateless (no DI) so orders don't depend on the ads module. */
  private readonly conversions = new ConversionsService();
  constructor(
    private readonly fulfillment: FulfillmentService,
    private readonly emails: EmailService,
  ) {}

  async checkout(input: CheckoutInput, client: { ip?: string | null; userAgent?: string | null } = {}) {
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
        // Ad attribution (slice 3). Only kept when the shopper consented to marketing cookies.
        attribution: input.attribution?.consent
          ? { consent: true, fbp: input.attribution.fbp ?? null, fbc: input.attribution.fbc ?? null, sourceUrl: input.attribution.sourceUrl ?? null, ip: client.ip ?? null, ua: client.userAgent?.slice(0, 500) ?? null, at: new Date().toISOString() }
          : { consent: false },
      },
      include: { lines: true },
    });

    // Return to the store's own domain when it has one (slice 2), else the platform URL.
    const urls = await DomainsService.storeUrls(store);
    const successUrl = `${urls.origin}/checkout/complete?orderId=${order.id}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${urls.origin}${urls.shopPath}${urls.shopPath.includes('?') ? '&' : '?'}checkout=cancelled`;

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
    let detail: string | null = null;
    if (p.checkoutId && order.providerCheckoutId && order.providerCheckoutId !== p.checkoutId) {
      detail = `checkout ${p.checkoutId} ≠ expected ${order.providerCheckoutId}`;
    } else if (
      (p.amountCents != null && p.amountCents !== order.totalCents) ||
      (p.currency && p.currency.toUpperCase() !== order.currency.toUpperCase())
    ) {
      detail = `paid ${p.amountCents} ${p.currency?.toUpperCase()} but order total is ${order.totalCents} ${order.currency}`;
    }
    if (detail) {
      this.logger.error(`Order ${orderId}: ${detail} (payment ${p.paymentId})`);
      await prisma.order.update({ where: { id: orderId }, data: { flag: 'payment_mismatch', flagDetail: `${detail} · payment ${p.paymentId}`, flaggedAt: new Date() } });
      const store = await prisma.store.findUnique({ where: { id: order.storeId } });
      throw new PaymentMismatchError(orderId, store?.organizationId ?? null, detail);
    }
    const r = await this.markPaid(orderId, p.paymentId, p.provider, p.checkoutId);
    return r.transitioned ? 'order_paid' : 'order_already_processed';
  }

  async markPaymentFailed(orderId: string, status: 'FAILED' | 'CANCELLED') {
    return prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { status },
    });
  }

  /**
   * PENDING_PAYMENT → PAID exactly once. The conditional update is the lock: concurrent callers
   * (duplicate webhooks, completed + async_payment_succeeded) see count 0 and do nothing, so
   * fulfillment is routed once.
   */
  async markPaid(orderId: string, providerPaymentId: string, provider = 'stub', providerCheckoutId?: string) {
    const r = await prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
      data: {
        status: OrderStatus.PAID,
        provider,
        providerPaymentId,
        ...(providerCheckoutId ? { providerCheckoutId } : {}),
      },
    });
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (r.count !== 1) return { ...order, transitioned: false };

    // 1) Fulfilment first, right after the paid write. If the process dies before or during this,
    //    sweepPaid() finds the PAID order with no fulfilment and routes it (idempotent).
    await this.startFulfillment(orderId);
    // 2) Confirmation email: only the outbox row is written here; delivery is a job / background
    //    send and never delays (or blocks) fulfilment. A lost row is recreated by sweepPaid().
    await this.emails.orderEvent('ORDER_CONFIRMED', orderId);
    // 3) Meta Conversions API Purchase (event_id order_<id>, shared with the browser Pixel). The
    //    row is written here; sending is background with retries (capi.dispatch). Never throws.
    await this.conversions.orderPaid(orderId);
    return { ...order, transitioned: true };
  }

  /** Enqueue routing (jobId per order) or, without Redis, route inline. Never throws: the sweeper retries. */
  private async startFulfillment(orderId: string) {
    try {
      const q = await enqueueRouteFulfillment(orderId);
      if (q.inline) await this.fulfillment.routeOrder(orderId);
    } catch (e: any) {
      this.logger.error(`Order ${orderId}: fulfilment not started yet (${e?.message ?? e}); the sweeper will retry`);
    }
  }

  /**
   * Crash recovery for the paid → fulfilment → email chain. Every step is idempotent
   * (Fulfillment.orderId unique, route jobId per order, EmailMessage.dedupeKey unique), so several
   * instances can sweep at once. graceMs leaves a just-paid order to the request that's handling it.
   */
  async sweepPaid(now = new Date(), graceMs = 2 * 60_000) {
    const cutoff = new Date(now.getTime() - graceMs);
    const unrouted = await prisma.order.findMany({
      where: { status: OrderStatus.PAID, fulfillment: null, updatedAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });
    for (const o of unrouted) await this.startFulfillment(o.id);
    const unconfirmed = await prisma.order.findMany({
      where: {
        status: { notIn: [OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED, OrderStatus.FAILED] },
        providerPaymentId: { not: null },
        createdAt: { gt: new Date(now.getTime() - 48 * 3600_000) },
        updatedAt: { lt: cutoff },
        emails: { none: { kind: 'ORDER_CONFIRMED' } },
      },
      select: { id: true },
      take: 50,
    });
    for (const o of unconfirmed) await this.emails.orderEvent('ORDER_CONFIRMED', o.id);
    // 3) Paid + consented orders whose CAPI row was lost (crash between markPaid and orderPaid)
    const capi = await this.conversions.sweepMissing(now, graceMs);
    return { routed: unrouted.map((o) => o.id), confirmed: unconfirmed.map((o) => o.id), capi };
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
