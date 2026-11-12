import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { prisma, OrderStatus, FulfillmentStatus, type Fulfillment } from '@storeforge/db';
import type { NormalizedOrder } from '@storeforge/shared';
import { SuppliersService } from '../suppliers/suppliers.service';
import { enqueueTrackingPoll } from '../jobs/queues';
import { EmailService } from '../email/email.service';

@Injectable()
export class FulfillmentService {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly emails: EmailService,
  ) {}

  async routeOrder(orderId: string): Promise<Fulfillment> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        lines: { include: { storeProduct: { include: { product: true } } } },
        store: true,
        fulfillment: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.fulfillment) return order.fulfillment;

    const firstProduct = order.lines[0]?.storeProduct.product;
    if (!firstProduct) throw new BadRequestException('Order has no lines');

    let fulfillment: Fulfillment;
    try {
      fulfillment = await prisma.fulfillment.create({
        data: {
          orderId: order.id,
          supplierId: firstProduct.supplierId,
          status: FulfillmentStatus.PENDING,
        },
      });
    } catch (e: any) {
      // Fulfillment.orderId is unique: a concurrent route already created it.
      if (e?.code === 'P2002') return prisma.fulfillment.findUniqueOrThrow({ where: { orderId: order.id } });
      throw e;
    }

    const auto =
      order.store.autoFulfill || process.env.AUTO_FULFILL_ENABLED === 'true';

    if (auto) {
      return this.approveAndSubmit(order.id);
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.AWAITING_MERCHANT_APPROVAL },
    });

    return fulfillment;
  }

  async approveAndSubmit(orderId: string): Promise<Fulfillment> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        lines: { include: { storeProduct: { include: { product: true } } } },
        fulfillment: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === OrderStatus.REFUNDED || order.status === OrderStatus.CANCELLED || order.status === OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException(`Can't send a ${order.status.toLowerCase().replace(/_/g, ' ')} order to the supplier`);
    }

    let fulfillment = order.fulfillment;
    if (!fulfillment) {
      const firstProduct = order.lines[0]?.storeProduct.product;
      if (!firstProduct) throw new BadRequestException('Order has no lines');
      fulfillment = await prisma.fulfillment.create({
        data: {
          orderId: order.id,
          supplierId: firstProduct.supplierId,
          status: FulfillmentStatus.PENDING,
        },
      });
    }

    const supplier = await prisma.supplier.findUniqueOrThrow({
      where: { id: fulfillment.supplierId },
    });
    const adapter = this.suppliers.get(supplier.code);

    const normalized: NormalizedOrder = {
      id: order.id,
      externalRef: order.id,
      shipping: {
        name: order.customerName,
        line1: order.shippingLine1,
        line2: order.shippingLine2 ?? undefined,
        city: order.shippingCity,
        state: order.shippingState,
        postalCode: order.shippingPostalCode,
        country: order.shippingCountry,
      },
      lines: order.lines.map((l) => ({
        sku: l.sku,
        externalProductId: l.storeProduct.product.externalId,
        quantity: l.quantity,
        unitCostCents: l.unitCostCents,
      })),
    };

    const { externalId } = await adapter.createFulfillment(normalized);

    const updated: Fulfillment = await prisma.fulfillment.update({
      where: { id: fulfillment.id },
      data: {
        status: FulfillmentStatus.SUBMITTED,
        externalId,
        submittedAt: new Date(),
      },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.FULFILLMENT_SUBMITTED },
    });

    await prisma.trackingEvent.create({
      data: {
        orderId: order.id,
        status: 'submitted',
        description: `Submitted to ${supplier.name} (${externalId})`,
      },
    });

    const track = await enqueueTrackingPoll(updated.id);
    if (track.inline) {
      await this.pollTracking(updated.id);
    }

    return updated;
  }

  async pollTracking(fulfillmentId: string): Promise<void> {
    const fulfillment = await prisma.fulfillment.findUnique({
      where: { id: fulfillmentId },
      include: { supplier: true },
    });
    if (!fulfillment?.externalId) return;

    const adapter = this.suppliers.get(fulfillment.supplier.code);
    const info = await adapter.getTracking(fulfillment.externalId);

    if (info.trackingNumber) {
      await prisma.fulfillment.update({
        where: { id: fulfillmentId },
        data: {
          trackingNumber: info.trackingNumber,
          carrier: info.carrier,
          status: FulfillmentStatus.SHIPPED,
          shippedAt: fulfillment.shippedAt ?? new Date(),
        },
      });
      // Transition once → one "shipped" email, however often tracking is polled.
      const shipped = await prisma.order.updateMany({
        where: { id: fulfillment.orderId, status: { in: [OrderStatus.PAID, OrderStatus.AWAITING_MERCHANT_APPROVAL, OrderStatus.FULFILLMENT_SUBMITTED] } },
        data: { status: OrderStatus.SHIPPED },
      });
      if (shipped.count === 1) await this.emails.orderEvent('ORDER_SHIPPED', fulfillment.orderId);
    }
    if (info.status === 'delivered') {
      const delivered = await prisma.order.updateMany({
        where: { id: fulfillment.orderId, status: OrderStatus.SHIPPED },
        data: { status: OrderStatus.DELIVERED },
      });
      if (delivered.count === 1) {
        await this.emails.orderEvent('ORDER_DELIVERED', fulfillment.orderId);
      }
    }

    for (const ev of info.events) {
      await prisma.trackingEvent.create({
        data: {
          orderId: fulfillment.orderId,
          status: ev.status,
          description: ev.description,
          occurredAt: new Date(ev.at),
        },
      });
    }
  }
}
