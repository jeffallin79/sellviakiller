import { Injectable, Logger } from '@nestjs/common';
import { prisma } from '@storeforge/db';
import { NotificationsService } from './notifications.service';

const CLOSED = new Set(['won', 'lost', 'warning_closed', 'prevented']);

const usd = (cents: number, cur: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: (cur || 'usd').toUpperCase() }).format(cents / 100);

/**
 * charge.dispute.created / updated / closed / funds_withdrawn / funds_reinstated.
 * Destination charges settle on the platform account, so Stripe debits the platform; we record the
 * dispute, flag order + store, and alert merchant and platform. Evidence is submitted in the
 * Stripe Dashboard for now. Idempotent: upsert on dispute id, notifications deduped per status.
 */
@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);
  constructor(private readonly notifications: NotificationsService) {}

  async apply(d: any, eventType: string) {
    const pi = typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id ?? null;
    const charge = typeof d.charge === 'string' ? d.charge : d.charge?.id ?? null;
    const order = pi ? await prisma.order.findUnique({ where: { providerPaymentId: pi }, include: { store: true } }) : null;
    const organizationId = order?.store.organizationId ?? null;
    const status: string = d.status ?? 'needs_response';
    const closed = CLOSED.has(status);
    const evidenceDueBy = d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000) : null;

    const prev = await prisma.dispute.findUnique({ where: { providerDisputeId: d.id } });
    const rec = await prisma.dispute.upsert({
      where: { providerDisputeId: d.id },
      create: {
        providerDisputeId: d.id, chargeId: charge, paymentIntentId: pi, orderId: order?.id ?? null, storeId: order?.storeId ?? null, organizationId,
        amountCents: d.amount ?? 0, currency: d.currency ?? 'usd', reason: d.reason ?? null, status, evidenceDueBy, closedAt: closed ? new Date() : null,
      },
      update: { status, amountCents: d.amount ?? undefined, reason: d.reason ?? undefined, evidenceDueBy: evidenceDueBy ?? undefined, ...(closed && !prev?.closedAt ? { closedAt: new Date() } : {}) },
    });

    if (order) {
      const flag = status === 'lost' ? 'dispute_lost' : closed ? null : 'dispute_open';
      if (flag) {
        await prisma.order.update({ where: { id: order.id }, data: { flag, flagDetail: `${rec.reason ?? 'dispute'} · ${usd(rec.amountCents, rec.currency)} · ${status}`, flaggedAt: new Date() } });
      } else if (order.flag?.startsWith('dispute_')) {
        await prisma.order.update({ where: { id: order.id }, data: { flag: null, flagDetail: null, flaggedAt: null } });
      }
      const open = await prisma.dispute.count({ where: { storeId: order.storeId, closedAt: null } });
      await prisma.store.update({
        where: { id: order.storeId },
        data: open > 0 ? { riskFlag: `open_disputes:${open}`, riskFlaggedAt: new Date() } : { riskFlag: null, riskFlaggedAt: null },
      });
    } else {
      this.logger.error(`Dispute ${d.id} (${status}) on ${pi ?? charge}: no matching order`);
    }

    const amount = usd(rec.amountCents, rec.currency);
    const due = evidenceDueBy ? ` Respond by ${evidenceDueBy.toISOString().slice(0, 10)} (UTC).` : '';
    const title =
      eventType === 'charge.dispute.created' ? `Card dispute opened: ${amount}`
      : closed ? `Dispute ${status === 'won' ? 'won' : status === 'lost' ? 'lost' : 'closed'}: ${amount}`
      : `Dispute updated: ${status.replace(/_/g, ' ')}`;
    const body = `${order ? `Order ${order.id.slice(-8).toUpperCase()} at ${order.store.name}. ` : ''}Reason: ${rec.reason ?? 'not given'}.${closed ? '' : due} Evidence goes through the Stripe Dashboard for now.`;
    const kind = eventType === 'charge.dispute.created' ? 'dispute_opened' : closed ? 'dispute_closed' : 'dispute_updated';
    const severity = status === 'lost' || eventType === 'charge.dispute.created' ? 'critical' : 'warning';
    const key = `${d.id}:${eventType === 'charge.dispute.funds_withdrawn' || eventType === 'charge.dispute.funds_reinstated' ? eventType : status}`;
    if (organizationId) await this.notifications.notify({ organizationId, kind, severity, title, body, orderId: order?.id, dedupeKey: `m:${key}` });
    await this.notifications.notify({ organizationId: null, kind, severity, title, body, orderId: order?.id, dedupeKey: `p:${key}` });
    return rec;
  }
}
