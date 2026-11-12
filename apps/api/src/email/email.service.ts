import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { prisma, EmailStatus, type EmailKind } from '@storeforge/db';
import { renderOrderEmail, trackingUrl, type EmailContext } from './templates';
import { getEmailTransport, PermanentEmailError } from './transport';
import { enqueueEmailSend } from '../jobs/queues';
import { DomainsService } from '../domains/domains.service';

export const MAX_EMAIL_ATTEMPTS = 5;
export const orderNumber = (orderId: string) => orderId.slice(-8).toUpperCase();

/** "Juniper Goods <orders@mail.storeforge.app>" — display name is the shop, address is ours (SPF/DKIM). */
export function fromHeader(storeName: string) {
  const addr = process.env.EMAIL_FROM_ADDRESS ?? 'orders@storeforge.local';
  const name = storeName.replace(/["<>\r\n]/g, '').slice(0, 60) || 'StoreForge';
  return `"${name}" <${addr}>`;
}

/**
 * Customer order emails. Each trigger is written once (EmailMessage.dedupeKey is unique), so
 * webhook replays and repeated tracking polls never send twice. Sending goes through the
 * `email.send` queue (inline when Redis is down). Failures never break the order flow.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  async orderEvent(kind: EmailKind, orderId: string, opts: { refundId?: string; refundAmountCents?: number } = {}) {
    try {
      const dedupeKey = kind === 'ORDER_REFUNDED' ? `${kind}:${orderId}:${opts.refundId ?? 'full'}` : `${kind}:${orderId}`;
      const existing = await prisma.emailMessage.findUnique({ where: { dedupeKey } });
      if (existing) return { duplicate: true as const, id: existing.id };

      const ctx = await this.buildContext(orderId, kind, opts);
      if (!ctx) return { skipped: 'order_not_found' as const };
      const r = renderOrderEmail(kind, ctx.ctx);
      let msg;
      try {
        msg = await prisma.emailMessage.create({
          data: {
            kind,
            dedupeKey,
            orderId,
            storeId: ctx.storeId,
            to: ctx.to,
            from: fromHeader(ctx.ctx.store.name),
            replyTo: ctx.replyTo,
            subject: r.subject,
            html: r.html,
            text: r.text,
          },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') return { duplicate: true as const };
        throw e;
      }
      const q = await enqueueEmailSend(msg.id);
      if (q.inline) await this.send(msg.id).catch(() => null);
      return { id: msg.id, queued: q.queued };
    } catch (e: any) {
      this.logger.error(`email ${kind} for order ${orderId} not created: ${e?.message ?? e}`);
      return { error: String(e?.message ?? e) };
    }
  }

  /** Worker body. Throws on retryable failure so BullMQ backs off and retries. */
  async send(emailId: string): Promise<void> {
    const m = await prisma.emailMessage.findUnique({ where: { id: emailId } });
    if (!m || m.status === EmailStatus.SENT) return;
    const transport = getEmailTransport();
    const claim = await prisma.emailMessage.updateMany({
      where: { id: emailId, status: { not: EmailStatus.SENT } },
      data: { attempts: { increment: 1 }, transport: transport.kind },
    });
    if (!claim.count) return;
    try {
      const res = await transport.send({
        id: m.id,
        from: m.from,
        to: m.to,
        replyTo: m.replyTo,
        subject: m.subject,
        html: m.html,
        text: m.text,
        idempotencyKey: `sf-email-${m.id}`,
        tags: { kind: m.kind, ...(m.storeId ? { store: m.storeId } : {}) },
      });
      await prisma.emailMessage.update({
        where: { id: emailId },
        data: { status: EmailStatus.SENT, sentAt: new Date(), providerMessageId: res.providerMessageId, lastError: null },
      });
    } catch (e: any) {
      const permanent = e instanceof PermanentEmailError || m.attempts + 1 >= MAX_EMAIL_ATTEMPTS;
      await prisma.emailMessage.update({
        where: { id: emailId },
        data: { status: permanent ? EmailStatus.FAILED : EmailStatus.QUEUED, lastError: String(e?.message ?? e).slice(0, 1000) },
      });
      this.logger.warn(`email ${emailId} ${permanent ? 'failed' : 'will retry'}: ${e?.message ?? e}`);
      if (!permanent) throw e;
    }
  }

  /** Merchant "Send again" for a FAILED/QUEUED message (same row, same idempotency key). */
  async retry(organizationId: string, id: string) {
    const m = await prisma.emailMessage.findFirst({ where: { id, store: { organizationId } } });
    if (!m) throw new NotFoundException('Email not found');
    if (m.status !== EmailStatus.SENT) {
      await prisma.emailMessage.update({ where: { id }, data: { status: EmailStatus.QUEUED } });
      const q = await enqueueEmailSend(id);
      if (q.inline) await this.send(id).catch(() => null);
    }
    return this.get(organizationId, id);
  }

  async list(organizationId: string, opts: { storeId?: string; orderId?: string; take?: number } = {}) {
    return prisma.emailMessage.findMany({
      where: { store: { organizationId }, ...(opts.storeId ? { storeId: opts.storeId } : {}), ...(opts.orderId ? { orderId: opts.orderId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.take ?? 50, 200),
      select: { id: true, kind: true, to: true, from: true, subject: true, status: true, transport: true, attempts: true, lastError: true, sentAt: true, createdAt: true, orderId: true, storeId: true },
    });
  }

  async get(organizationId: string, id: string) {
    const m = await prisma.emailMessage.findFirst({ where: { id, store: { organizationId } } });
    if (!m) throw new NotFoundException('Email not found');
    return m;
  }

  private async buildContext(orderId: string, kind: EmailKind, opts: { refundAmountCents?: number }) {
    const o = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        lines: { include: { storeProduct: { include: { product: true } } } },
        fulfillment: true,
        store: { include: { organization: { include: { members: { include: { user: true }, orderBy: { createdAt: 'asc' } } } } } },
      },
    });
    if (!o) return null;
    const urls = await DomainsService.storeUrls(o.store);
    const etas = o.lines.map((l) => l.storeProduct.product);
    const eta = etas.length ? { minDays: Math.max(...etas.map((p) => p.etaDaysMin)), maxDays: Math.max(...etas.map((p) => p.etaDaysMax)) } : null;
    const owner = o.store.organization.members.find((m) => m.role === 'owner') ?? o.store.organization.members[0];
    const tracking = o.fulfillment?.trackingNumber
      ? { carrier: o.fulfillment.carrier, number: o.fulfillment.trackingNumber, url: trackingUrl(o.fulfillment.carrier, o.fulfillment.trackingNumber) }
      : null;
    const ctx: EmailContext = {
      store: { name: o.store.name, shopUrl: `${urls.origin}${urls.shopPath === '/' ? '/' : urls.shopPath}` },
      order: {
        id: o.id,
        number: orderNumber(o.id),
        createdAt: o.createdAt,
        customerName: o.customerName,
        currency: o.currency,
        lines: o.lines.map((l) => ({ title: l.title, quantity: l.quantity, unitPriceCents: l.unitPriceCents })),
        subtotalCents: o.subtotalCents,
        shippingCents: o.shippingCents,
        totalCents: o.totalCents,
        refundedCents: o.refundedCents,
        shipTo: [
          o.customerName,
          o.shippingLine1,
          ...(o.shippingLine2 ? [o.shippingLine2] : []),
          `${o.shippingCity}, ${o.shippingState} ${o.shippingPostalCode}`,
          o.shippingCountry,
        ],
        eta,
      },
      tracking: kind === 'ORDER_SHIPPED' ? tracking : null,
      refund: kind === 'ORDER_REFUNDED' ? { amountCents: opts.refundAmountCents ?? o.refundedCents } : null,
    };
    return { ctx, storeId: o.storeId, to: o.customerEmail, replyTo: owner?.user.email ?? null };
  }
}
