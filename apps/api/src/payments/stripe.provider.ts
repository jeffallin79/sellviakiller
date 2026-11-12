import Stripe from 'stripe';
import {
  PaymentProvider,
  ProviderEvent,
  NormalizedSubscription,
  PayoutAccountStatus,
  WebhookEndpoint,
  WebhookSignatureError,
  ProviderNotConfiguredError,
} from './payment-provider';

const STATUS: Record<string, NormalizedSubscription['status']> = {
  active: 'ACTIVE',
  trialing: 'TRIALING',
  past_due: 'PAST_DUE',
  unpaid: 'PAST_DUE',
  paused: 'PAST_DUE',
  canceled: 'CANCELLED',
  incomplete_expired: 'CANCELLED',
  incomplete: 'INCOMPLETE',
};

export function normalizeStripeSubscription(s: Stripe.Subscription): NormalizedSubscription {
  const item = s.items?.data?.[0];
  // current_period_end lives on items in current API versions; older payloads had it on the subscription.
  const periodEnd =
    (item as { current_period_end?: number } | undefined)?.current_period_end ??
    (s as unknown as { current_period_end?: number }).current_period_end;
  return {
    providerSubscriptionId: s.id,
    providerCustomerId: typeof s.customer === 'string' ? s.customer : s.customer?.id ?? null,
    organizationId: (s.metadata?.organizationId as string) || null,
    priceId: item?.price?.id ?? null,
    status: STATUS[s.status] ?? 'INCOMPLETE',
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
  };
}

export class StripePaymentProvider implements PaymentProvider {
  readonly kind = 'stripe' as const;
  private readonly stripe: Stripe;

  constructor(secretKey: string, client?: Stripe) {
    this.stripe = client ?? new Stripe(secretKey, { maxNetworkRetries: 2, appInfo: { name: 'StoreForge' } });
    this.secretKey = secretKey;
  }
  private readonly secretKey: string;

  /** Exposed for tests (webhook signing helpers). */
  get client() {
    return this.stripe;
  }

  mode() {
    return this.secretKey.startsWith('sk_live_') || this.secretKey.startsWith('rk_live_') ? ('live' as const) : ('test' as const);
  }

  async createSubscriptionCheckout(o: {
    organizationId: string;
    planId: string;
    priceId: string;
    email: string;
    customerId?: string | null;
    successUrl: string;
    cancelUrl: string;
  }) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        line_items: [{ price: o.priceId, quantity: 1 }],
        ...(o.customerId ? { customer: o.customerId } : { customer_email: o.email }),
        client_reference_id: o.organizationId,
        metadata: { organizationId: o.organizationId, planId: o.planId, kind: 'saas_subscription' },
        subscription_data: { metadata: { organizationId: o.organizationId, planId: o.planId } },
        success_url: o.successUrl,
        cancel_url: o.cancelUrl,
        allow_promotion_codes: true,
      },
      { idempotencyKey: `sf-subco-${o.organizationId}-${o.planId}-${Math.floor(Date.now() / 60000)}` },
    );
    return {
      url: session.url ?? o.cancelUrl,
      sessionId: session.id,
      customerId: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? o.customerId ?? null,
    };
  }

  async createBillingPortal(o: { customerId: string; returnUrl: string }) {
    const p = await this.stripe.billingPortal.sessions.create({ customer: o.customerId, return_url: o.returnUrl });
    return { url: p.url };
  }

  async getSubscription(id: string) {
    return normalizeStripeSubscription(await this.stripe.subscriptions.retrieve(id));
  }

  async createPayoutAccount(o: { organizationId: string; email: string }) {
    const acct = await this.stripe.accounts.create(
      {
        type: 'express',
        email: o.email,
        metadata: { organizationId: o.organizationId },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      },
      { idempotencyKey: `sf-acct-${o.organizationId}` },
    );
    return { accountId: acct.id };
  }

  async createPayoutOnboardingLink(o: { accountId: string; refreshUrl: string; returnUrl: string }) {
    const link = await this.stripe.accountLinks.create({
      account: o.accountId,
      refresh_url: o.refreshUrl,
      return_url: o.returnUrl,
      type: 'account_onboarding',
    });
    return { url: link.url };
  }

  async getPayoutAccount(accountId: string): Promise<PayoutAccountStatus> {
    return accountStatus(await this.stripe.accounts.retrieve(accountId));
  }

  async createOrderCheckout(o: {
    orderId: string;
    storeSlug: string;
    currency: string;
    customerEmail: string;
    lines: { name: string; unitAmountCents: number; quantity: number }[];
    shippingCents: number;
    destinationAccountId: string;
    applicationFeeCents: number;
    successUrl: string;
    cancelUrl: string;
  }) {
    const currency = o.currency.toLowerCase();
    const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = o.lines.map((l) => ({
      quantity: l.quantity,
      price_data: { currency, unit_amount: l.unitAmountCents, product_data: { name: l.name.slice(0, 250) } },
    }));
    if (o.shippingCents > 0) {
      line_items.push({ quantity: 1, price_data: { currency, unit_amount: o.shippingCents, product_data: { name: 'Shipping' } } });
    }
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items,
        customer_email: o.customerEmail,
        client_reference_id: o.orderId,
        metadata: { orderId: o.orderId, storeSlug: o.storeSlug, kind: 'store_order' },
        payment_intent_data: {
          // Destination charge: funds land in the merchant's Express account; Stripe pays them out.
          transfer_data: { destination: o.destinationAccountId },
          on_behalf_of: o.destinationAccountId,
          ...(o.applicationFeeCents > 0 ? { application_fee_amount: o.applicationFeeCents } : {}),
          metadata: { orderId: o.orderId, kind: 'store_order' },
        },
        success_url: o.successUrl,
        cancel_url: o.cancelUrl,
      },
      { idempotencyKey: `sf-order-${o.orderId}` },
    );
    return { checkoutId: session.id, url: session.url ?? o.cancelUrl };
  }

  async ensureCustomer(o: { organizationId: string; email: string; customerId?: string | null }) {
    if (o.customerId) return { customerId: o.customerId };
    const c = await this.stripe.customers.create(
      { email: o.email, metadata: { organizationId: o.organizationId } },
      { idempotencyKey: `sf-cus-${o.organizationId}` },
    );
    return { customerId: c.id };
  }

  async createTopUpIntent(o: {
    organizationId: string;
    walletId: string;
    customerId: string;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
  }) {
    const pi = await this.stripe.paymentIntents.create(
      {
        amount: o.amountCents,
        currency: o.currency.toLowerCase(),
        customer: o.customerId,
        // Saved card enables auto-reload (slice 3 job charges off_session).
        setup_future_usage: 'off_session',
        automatic_payment_methods: { enabled: true },
        description: 'StoreForge Ad Fuel top-up',
        metadata: { kind: 'ad_fuel_topup', organizationId: o.organizationId, walletId: o.walletId },
      },
      { idempotencyKey: o.idempotencyKey },
    );
    return { paymentIntentId: pi.id, clientSecret: pi.client_secret, status: pi.status };
  }

  async refundPayment(o: { paymentId: string; amountCents: number; idempotencyKey: string; metadata?: Record<string, string> }) {
    const r = await this.stripe.refunds.create(
      { payment_intent: o.paymentId, amount: o.amountCents, metadata: o.metadata },
      { idempotencyKey: o.idempotencyKey },
    );
    return { refundId: r.id, status: r.status ?? 'pending' };
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined, endpoint: WebhookEndpoint): ProviderEvent {
    const secret =
      endpoint === 'connect' ? process.env.STRIPE_CONNECT_WEBHOOK_SECRET : process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new ProviderNotConfiguredError(`Webhook secret for ${endpoint} endpoint is not set`);
    if (!signature) throw new WebhookSignatureError('Missing Stripe-Signature header');
    try {
      return this.stripe.webhooks.constructEvent(rawBody, signature, secret) as unknown as ProviderEvent;
    } catch (e) {
      throw new WebhookSignatureError(e instanceof Error ? e.message : 'Invalid signature');
    }
  }
}

export function accountStatus(a: Stripe.Account): PayoutAccountStatus {
  return {
    accountId: a.id,
    chargesEnabled: Boolean(a.charges_enabled),
    payoutsEnabled: Boolean(a.payouts_enabled),
    detailsSubmitted: Boolean(a.details_submitted),
  };
}
