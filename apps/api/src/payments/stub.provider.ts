import { randomUUID } from 'crypto';
import {
  PaymentProvider,
  ProviderEvent,
  NormalizedSubscription,
  WebhookSignatureError,
} from './payment-provider';

/** Local/demo provider. No network, no money. Used when STRIPE_SECRET_KEY is unset. */
export class StubPaymentProvider implements PaymentProvider {
  readonly kind = 'stub' as const;
  mode() {
    return 'stub' as const;
  }

  async createSubscriptionCheckout(o: { organizationId: string; successUrl: string; customerId?: string | null }) {
    return {
      url: `${o.successUrl}${o.successUrl.includes('?') ? '&' : '?'}stub=1`,
      sessionId: `stub_cs_${o.organizationId.slice(-8)}`,
      customerId: o.customerId ?? `stub_cus_${o.organizationId.slice(-8)}`,
    };
  }
  async createBillingPortal(o: { returnUrl: string }) {
    return { url: `${o.returnUrl}${o.returnUrl.includes('?') ? '&' : '?'}stub_portal=1` };
  }
  async getSubscription(id: string): Promise<NormalizedSubscription> {
    return {
      providerSubscriptionId: id,
      providerCustomerId: null,
      organizationId: null,
      priceId: null,
      status: 'ACTIVE',
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      cancelAtPeriodEnd: false,
    };
  }
  async createPayoutAccount(o: { organizationId: string }) {
    return { accountId: `stub_acct_${o.organizationId.slice(-8)}` };
  }
  async createPayoutOnboardingLink(o: { returnUrl: string }) {
    return { url: `${o.returnUrl}${o.returnUrl.includes('?') ? '&' : '?'}stub=1` };
  }
  async getPayoutAccount(accountId: string) {
    return { accountId, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true };
  }
  async createOrderCheckout(o: { orderId: string; successUrl: string }) {
    const url = o.successUrl.replace('{CHECKOUT_SESSION_ID}', `stub_cs_${o.orderId.slice(-8)}`);
    return { checkoutId: `stub_cs_${o.orderId}`, url: `${url}&stub_paid=1` };
  }
  async ensureCustomer(o: { organizationId: string; customerId?: string | null }) {
    return { customerId: o.customerId ?? `stub_cus_${o.organizationId.slice(-8)}` };
  }
  async createTopUpIntent(_o: { amountCents: number }) {
    return { paymentIntentId: `stub_pi_${randomUUID()}`, clientSecret: null, status: 'succeeded' };
  }
  async refundPayment(_o: { paymentId: string }) {
    return { refundId: `stub_re_${randomUUID()}`, status: 'succeeded' };
  }
  verifyWebhook(): ProviderEvent {
    throw new WebhookSignatureError('Payments are in stub mode; webhooks are disabled');
  }
}
