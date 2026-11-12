import { Injectable, Logger } from '@nestjs/common';
import { prisma } from '@storeforge/db';
import { OrdersService } from '../orders/orders.service';
import { BillingService } from '../billing/billing.service';
import { FuelService } from './fuel.service';
import { PayoutsService } from './payouts.service';
import { getPaymentProvider, type ProviderEvent, type WebhookEndpoint } from './index';
import { accountStatus } from './stripe.provider';

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
  ) {}

  async process(event: ProviderEvent, endpoint: WebhookEndpoint): Promise<WebhookResult> {
    const provider = getPaymentProvider();
    const existing = await prisma.webhookEvent.findUnique({ where: { id: event.id } });
    if (existing?.processedAt) return { received: true, duplicate: true, handled: 'duplicate' };

    if (existing) {
      await prisma.webhookEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 } } });
    } else {
      await prisma.webhookEvent
        .create({ data: { id: event.id, provider: provider.kind, endpoint, type: event.type } })
        .catch(() => prisma.webhookEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 } } }));
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
      await prisma.webhookEvent.update({ where: { id: event.id }, data: { lastError: msg.slice(0, 1000) } });
      throw e; // non-2xx → Stripe retries
    }
  }

  private done(id: string, note: string | null) {
    return prisma.webhookEvent.update({ where: { id }, data: { processedAt: new Date(), lastError: note } });
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
        const r = await this.fuel.creditTopUp({
          paymentIntentId: o.id,
          amountCents: o.amount_received ?? o.amount,
          walletId: o.metadata.walletId,
          organizationId: o.metadata.organizationId,
          provider: 'stripe',
        });
        return r.credited ? 'fuel_credited' : 'fuel_duplicate';
      }
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed': {
        if (o.metadata?.kind !== 'ad_fuel_refund') return 'ignored';
        await this.fuel.applyRefundStatus(o.id, event.type === 'refund.failed' ? 'failed' : o.status);
        return 'fuel_refund_status';
      }
      case 'account.updated': {
        await this.payouts.apply(accountStatus(o));
        return 'payout_account_synced';
      }
      case 'charge.dispute.created':
        this.logger.warn(`Dispute ${o.id} on charge ${o.charge} (${endpoint}) — handle in Stripe Dashboard`);
        return 'logged';
      default:
        return 'ignored';
    }
  }
}
