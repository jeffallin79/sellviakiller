/**
 * Provider-neutral payments contract. Stripe is the only real implementation in
 * Phase 1; `StubPaymentProvider` keeps local/demo flows working until keys exist.
 * Never add Square back here (removed 2026-11-12) and no crypto in Phase 1.
 */

export type ProviderKind = 'stripe' | 'stub';
export type ProviderMode = 'live' | 'test' | 'stub';
export type WebhookEndpoint = 'platform' | 'connect';

export interface NormalizedSubscription {
  providerSubscriptionId: string;
  providerCustomerId: string | null;
  organizationId: string | null;
  priceId: string | null;
  status: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'INCOMPLETE';
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface PayoutAccountStatus {
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

/** Minimal event shape handlers need; Stripe events satisfy it as-is. */
export interface ProviderEvent {
  id: string;
  type: string;
  account?: string | null;
  livemode?: boolean;
  data: { object: any };
}

export interface PaymentProvider {
  readonly kind: ProviderKind;
  mode(): ProviderMode;

  // SaaS billing (Stripe Billing)
  createSubscriptionCheckout(opts: {
    organizationId: string;
    planId: string;
    priceId: string;
    email: string;
    customerId?: string | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionId: string; customerId: string | null }>;
  createBillingPortal(opts: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  getSubscription(providerSubscriptionId: string): Promise<NormalizedSubscription>;

  // Merchant payouts (Stripe Connect Express)
  createPayoutAccount(opts: { organizationId: string; email: string }): Promise<{ accountId: string }>;
  createPayoutOnboardingLink(opts: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  getPayoutAccount(accountId: string): Promise<PayoutAccountStatus>;

  // Storefront checkout (destination charge to the merchant's connected account)
  createOrderCheckout(opts: {
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
  }): Promise<{ checkoutId: string; url: string }>;

  // Ad Fuel (platform-account PaymentIntents + Refunds)
  ensureCustomer(opts: { organizationId: string; email: string; customerId?: string | null }): Promise<{ customerId: string }>;
  createTopUpIntent(opts: {
    organizationId: string;
    walletId: string;
    customerId: string;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ paymentIntentId: string; clientSecret: string | null; status: string }>;
  refundPayment(opts: {
    paymentId: string;
    amountCents: number;
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }): Promise<{ refundId: string; status: string }>;

  /** Throws on bad/missing signature. Never accepts unsigned payloads. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined, endpoint: WebhookEndpoint): ProviderEvent;
}

export class WebhookSignatureError extends Error {}
export class ProviderNotConfiguredError extends Error {}

export function priceIdForPlan(planId: string, dbPriceId?: string | null): string | null {
  return process.env[`STRIPE_PRICE_${planId.toUpperCase()}`] || dbPriceId || null;
}

export function planForPriceId(priceId: string | null): string | null {
  if (!priceId) return null;
  for (const p of ['starter', 'growth', 'scale']) {
    if (process.env[`STRIPE_PRICE_${p.toUpperCase()}`] === priceId) return p;
  }
  return null;
}

/** Platform fee on storefront orders, basis points. Default 0 (plans carry the revenue). */
export function platformFeeCents(totalCents: number): number {
  const bps = Math.max(0, Math.min(2000, Number(process.env.PLATFORM_FEE_BPS ?? 0) || 0));
  return Math.round((totalCents * bps) / 10000);
}
