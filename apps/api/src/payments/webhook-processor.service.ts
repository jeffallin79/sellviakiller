import { Injectable, Logger } from '@nestjs/common';
import { prisma, Prisma } from '@storeforge/db';
import { OrdersService, PaymentMismatchError } from '../orders/orders.service';
import { NotificationsService } from './notifications.service';
import { RefundsService } from '../orders/refunds.service';
import { AdWalletService } from '../ads/wallet.service';
import { BillingService } from '../billing/billing.service';
import { FuelService } from './fuel.service';
import { PayoutsService } from './payouts.service';
import { getPaymentProvider, type ProviderEvent, type WebhookEndpoint } from './index';
import { accountStatus } from './stripe.provider';
import { DisputesService } from './disputes.service';

/** How long a worker owns an event before another delivery may take over (crash safety). */
const LEASE_MS = 120_000;

export type WebhookResult = { received: true; duplicate?: boolean; handled: string };

/**
 * Applies verified provider events. Replay-safe twice over:
 *  1. WebhookEvent row keyed on the provider event id (processed events are skipped)
 *  2. every handler is itself idempotent (status guards, unique keys, re-fetch from provider)
 */
@Injectable()
export class WebhookProcessorService {
  private readonly logger = new Logger(WebhookProcessorService.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly billing: BillingService,
    private readonly fuel: FuelService,
    private readonly payouts: PayoutsService,
    private readonly disputes: DisputesService,
    private readonly notifications: NotificationsService,
    private readonly refunds: RefundsService,
  ) {}
  /** Stateless; not injected so the payments module doesn't depend on the ads module. */
  private readonly wallet = new AdWalletService();

  async process(event: ProviderEvent, endpoint: WebhookEndpoint): Promise<WebhookResult> {
    const provider = getPaymentProvider();
    const now = new Date();
    const lease = new Date(now.getTime() + LEASE_MS);

    // Claim. Only the worker that inserts the row (or re-claims a failed, unlocked one) dispatches.
    // Concurrent identical deliveries hit the unique constraint / held lease → 200, no dispatch.
    let claimed = false;
    try {
      await prisma.webhookEvent.create({ data: { id: event.id, provider: provider.kind, endpoint, type: event.type, lockedUntil: lease } });
      claimed = true;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
    if (!claimed) {
      // A previous attempt failed (lock released) or its worker died (lease expired): Stripe's retry may take it.
      const r = await prisma.webhookEvent.updateMany({
        where: { id: event.id, processedAt: null, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
        data: { lockedUntil: lease, attempts: { increment: 1 } },
      });
      if (r.count !== 1) return { received: true, duplicate: true, handled: 'duplicate' };
    }

    // Test-mode server must never act on live events (and vice versa).
    if (typeof event.livemode === 'boolean' && event.livemode !== (provider.mode() === 'live')) {
      await this.done(event.id, 'livemode_mismatch');
      return { received: true, handled: 'ignored_livemode_mismatch' };
    }

    try {
      const handled = await this.dispatch(event, endpoint);
      await this.done(event.id, null);
      return { received: true, handled };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof PaymentMismatchError) {
        const n = { kind: 'payment_mismatch', severity: 'critical' as const, title: 'Payment needs review', body: `A payment for order ${e.orderId.slice(-8).toUpperCase()} doesn't match the order (${e.detail}). The order is on hold; nothing has shipped.`, orderId: e.orderId };
        await this.notifications.notify({ ...n, organizationId: null, dedupeKey: `p:mismatch:${event.id}` });
        if (e.organizationId) await this.notifications.notify({ ...n, organizationId: e.organizationId, dedupeKey: `m:mismatch:${event.id}` });
      }
      // Unresolved + unlocked: Stripe's retry (non-2xx below) can re-claim it.
      await prisma.webhookEvent.update({ where: { id: event.id }, data: { lastError: msg.slice(0, 1000), lockedUntil: null } });
      throw e;
    }
  }

  private done(id: string, note: string | null) {
    return prisma.webhookEvent.update({ where: { id }, data: { processedAt: new Date(), lastError: note, lockedUntil: null } });
  }

  private async dispatch(event: ProviderEvent, endpoint: WebhookEndpoint): Promise<string> {
    const o = event.data?.object ?? {};
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        if (o.mode === 'subscription' && o.subscription) {
          const subId = typeof o.subscription === 'string' ? o.subscription : o.subscription.id;
          await this.billing.syncSubscription(subId, { organizationId: o.metadata?.organizationId ?? o.client_reference_id });
          return 'subscription_synced';
        }
        if (o.metadata?.kind === 'store_order' && o.payment_status === 'paid') {
          const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id;
          const r = await this.orders.markProviderPaid(o.metadata.orderId, {
            provider: 'stripe',
            paymentId: pi,
            checkoutId: o.id,
            amountCents: o.amount_total,
            currency: o.currency,
          });
          return r;
        }
        return 'ignored';
      }
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired': {
        if (o.metadata?.kind === 'store_order') {
          await this.orders.markPaymentFailed(o.metadata.orderId, event.type === 'checkout.session.expired' ? 'CANCELLED' : 'FAILED');
          return 'order_payment_failed';
        }
        return 'ignored';
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        await this.billing.syncSubscription(o.id, { organizationId: o.metadata?.organizationId });
        return 'subscription_synced';
      }
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed': {
        const subId =
          o.parent?.subscription_details?.subscription ?? (typeof o.subscription === 'string' ? o.subscription : o.subscription?.id);
        if (!subId) return 'ignored';
        await this.billing.syncSubscription(typeof subId === 'string' ? subId : subId.id);
        return 'subscription_synced';
      }
      case 'payment_intent.succeeded': {
        if (o.metadata?.kind !== 'ad_fuel_topup') return 'ignored';
        const pm = typeof o.payment_method === 'string' ? o.payment_method : o.payment_method?.id;
        const r = await this.fuel.creditTopUp({
          paymentIntentId: o.id,
          amountCents: o.amount_received ?? o.amount,
          walletId: o.metadata.walletId,
          organizationId: o.metadata.organizationId,
          provider: 'stripe',
          source: o.metadata.source === 'auto' ? 'auto' : 'manual',
          // Card saved for auto-reload only when the payment asked for it
          paymentMethodId: pm && (o.setup_future_usage === 'off_session' || o.metadata.source === 'auto') ? pm : null,
        });
        return r.credited ? 'fuel_credited' : 'fuel_duplicate';
      }
      case 'payment_intent.payment_failed': {
        if (o.metadata?.kind !== 'ad_fuel_topup' || o.metadata.source !== 'auto') return 'ignored';
        await this.wallet.reloadPaymentFailed(o.metadata.walletId, o.last_payment_error?.message ?? 'Payment failed');
        return 'autoreload_failed';
      }
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed': {
        if (o.metadata?.kind === 'store_order_refund') {
          await this.refunds.applyStatus({ refundId: o.id, status: event.type === 'refund.failed' ? 'failed' : o.status, orderRefundId: o.metadata.orderRefundId });
          return 'order_refund_status';
        }
        if (o.metadata?.kind !== 'ad_fuel_refund') return 'ignored';
        await this.fuel.applyRefundStatus(o.id, event.type === 'refund.failed' ? 'failed' : o.status);
        return 'fuel_refund_status';
      }
      case 'account.updated': {
        await this.payouts.apply(accountStatus(o));
        return 'payout_account_synced';
      }
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed':
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.funds_reinstated': {
        if (endpoint === 'connect') this.logger.warn(`Dispute ${o.id} arrived on the Connect endpoint (account ${event.account})`);
        await this.disputes.apply(o, event.type);
        return 'dispute_recorded';
      }
      default:
        return 'ignored';
    }
  }
}
