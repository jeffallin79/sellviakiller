import Stripe from 'stripe';
import { prisma } from '@storeforge/db';
import { StripePaymentProvider } from '../src/payments/stripe.provider';
import type { NormalizedSubscription, PayoutAccountStatus } from '../src/payments/payment-provider';

export const WHSEC = 'whsec_test_platform_secret';
export const WHSEC_CONNECT = 'whsec_test_connect_secret';
export const stripeSdk = new Stripe('sk_test_dummy');

let n = 0;
export const uid = (p = 'x') => `${p}_${Date.now().toString(36)}_${(n++).toString(36)}`;

/** StripePaymentProvider with network calls replaced by in-memory fakes. */
export class FakeStripeProvider extends StripePaymentProvider {
  subs = new Map<string, NormalizedSubscription>();
  accounts = new Map<string, PayoutAccountStatus>();
  refunds: { paymentId: string; amountCents: number; idempotencyKey: string }[] = [];
  refundStatus = 'pending';
  checkouts: any[] = [];
  constructor(key = 'sk_test_dummy') {
    super(key, stripeSdk);
  }
  async getSubscription(id: string) {
    const s = this.subs.get(id);
    if (!s) throw new Error(`no such subscription ${id}`);
    return s;
  }
  async getPayoutAccount(id: string) {
    return this.accounts.get(id) ?? { accountId: id, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
  }
  async createPayoutAccount(o: { organizationId: string }) {
    return { accountId: `acct_${o.organizationId.slice(-10)}` };
  }
  async createPayoutOnboardingLink(o: { accountId: string }) {
    return { url: `https://connect.stripe.test/onboard/${o.accountId}` };
  }
  async ensureCustomer(o: { organizationId: string; customerId?: string | null }) {
    return { customerId: o.customerId ?? `cus_${o.organizationId.slice(-10)}` };
  }
  async createSubscriptionCheckout(o: any) {
    return { url: `https://checkout.stripe.test/${o.planId}`, sessionId: uid('cs'), customerId: o.customerId };
  }
  async createOrderCheckout(o: any) {
    this.checkouts.push(o);
    return { checkoutId: `cs_${o.orderId}`, url: `https://checkout.stripe.test/${o.orderId}` };
  }
  async createTopUpIntent(o: any) {
    return { paymentIntentId: uid('pi'), clientSecret: 'pi_secret_x', status: 'requires_payment_method' };
  }
  async refundPayment(o: { paymentId: string; amountCents: number; idempotencyKey: string }) {
    this.refunds.push(o);
    return { refundId: uid('re'), status: this.refundStatus };
  }
}

export function signed(event: object, secret = WHSEC) {
  const payload = JSON.stringify(event);
  const header = stripeSdk.webhooks.generateTestHeaderString({ payload, secret });
  return { raw: Buffer.from(payload), header };
}

export function evt(type: string, object: any, extra: Partial<{ id: string; livemode: boolean; account: string }> = {}) {
  return { id: extra.id ?? uid('evt'), object: 'event', type, livemode: extra.livemode ?? false, account: extra.account, data: { object } };
}

export async function makeOrg(opts: { payout?: boolean } = {}) {
  const org = await prisma.organization.create({
    data: {
      name: uid('Org'),
      ...(opts.payout
        ? { payoutAccountId: uid('acct'), payoutProvider: 'stripe', payoutChargesEnabled: true, payoutPayoutsEnabled: true, payoutDetailsSubmitted: true }
        : {}),
    },
  });
  return org;
}

export async function seedPlans() {
  for (const [id, name, priceUsd, maxStores] of [
    ['starter', 'Starter', 29, 1],
    ['growth', 'Growth', 79, 3],
    ['scale', 'Scale', 199, 10],
  ] as const) {
    await prisma.plan.upsert({ where: { id }, update: {}, create: { id, name, priceUsd, maxStores, maxOrdersPerMonth: 100 } });
  }
}

export async function makeStoreWithProduct(organizationId: string, priceCents = 2500) {
  const supplier = await prisma.supplier.upsert({ where: { code: 'cj' }, update: {}, create: { code: 'cj', name: 'CJ' } });
  const product = await prisma.product.create({
    data: { supplierId: supplier.id, externalId: uid('ext'), title: 'Test Lamp', sku: uid('SKU'), priceCents, costCents: 900 },
  });
  const store = await prisma.store.create({ data: { organizationId, name: 'Test Store', slug: uid('s').toLowerCase().replace(/_/g, '-') } });
  const sp = await prisma.storeProduct.create({ data: { storeId: store.id, productId: product.id, priceCents } });
  return { store, sp, product };
}

export const checkoutInput = (slug: string, storeProductId: string, quantity = 1) => ({
  storeSlug: slug,
  email: 'buyer@example.com',
  name: 'Buyer',
  lines: [{ storeProductId, quantity }],
  shippingAddress: { line1: '1 Main', city: 'Regina', state: 'SK', postalCode: 'S4P', country: 'US' },
});
