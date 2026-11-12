import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@storeforge/db';
import { setPaymentProviderForTests } from '../src/payments';
import { StubPaymentProvider } from '../src/payments/stub.provider';
import { OrdersService } from '../src/orders/orders.service';
import { BillingService } from '../src/billing/billing.service';
import { FuelService } from '../src/payments/fuel.service';
import { PayoutsService } from '../src/payments/payouts.service';
import { WebhookProcessorService } from '../src/payments/webhook-processor.service';
import { NotificationsService } from '../src/payments/notifications.service';
import { DisputesService } from '../src/payments/disputes.service';
import { StripeWebhooksController } from '../src/payments/payments.controller';
import { FakeStripeProvider, WHSEC, WHSEC_CONNECT, signed, evt, makeOrg, seedPlans, makeStoreWithProduct, checkoutInput, uid } from './helpers';

let routed: string[] = [];
const fulfillment = { routeOrder: async (id: string) => { routed.push(id); return {} as any; } } as any;
const orders = new OrdersService(fulfillment);
const billing = new BillingService();
const fuel = new FuelService();
const payouts = new PayoutsService();
const notifications = new NotificationsService();
const processor = new WebhookProcessorService(orders, billing, fuel, payouts, new DisputesService(notifications), notifications);
const controller = new StripeWebhooksController(processor);
let fake: FakeStripeProvider;

const post = (event: object, secret = WHSEC, endpoint: 'platform' | 'connect' = 'platform') => {
  const { raw, header } = signed(event, secret);
  const req = { rawBody: raw } as any;
  return endpoint === 'platform' ? controller.platform(req, header) : controller.connect(req, header);
};

before(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = WHSEC_CONNECT;
  process.env.STRIPE_PRICE_STARTER = 'price_starter';
  process.env.STRIPE_PRICE_GROWTH = 'price_growth';
  process.env.STRIPE_PRICE_SCALE = 'price_scale';
  await seedPlans();
});
beforeEach(() => {
  routed = [];
  fake = new FakeStripeProvider();
  setPaymentProviderForTests(fake);
});
after(async () => {
  setPaymentProviderForTests(null);
  await prisma.$disconnect();
});

// ---------- signature verification ----------
test('webhook: valid signature accepted', async () => {
  const r = await post(evt('ping.unknown', {}));
  assert.equal(r.received, true);
});

test('webhook: missing, wrong-secret and tampered signatures rejected', async () => {
  const e = evt('payment_intent.succeeded', { id: 'pi_x', metadata: {} });
  await assert.rejects(() => controller.platform({ rawBody: Buffer.from(JSON.stringify(e)) } as any, undefined), /Invalid signature/);
  await assert.rejects(() => post(e, 'whsec_wrong'), /Invalid signature/);
  const { header } = signed(e);
  const tampered = Buffer.from(JSON.stringify({ ...e, data: { object: { id: 'pi_evil', amount: 999999 } } }));
  await assert.rejects(() => controller.platform({ rawBody: tampered } as any, header), /Invalid signature/);
  // platform-signed event must not pass the connect endpoint
  await assert.rejects(() => post(e, WHSEC, 'connect'), /Invalid signature/);
  assert.equal(await prisma.webhookEvent.count({ where: { id: e.id } }), 0);
});

test('webhook: unset secret → 503, stub mode never accepts webhooks', async () => {
  const saved = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  await assert.rejects(() => post(evt('x', {})), /not set/);
  process.env.STRIPE_WEBHOOK_SECRET = saved;
  setPaymentProviderForTests(new StubPaymentProvider());
  await assert.rejects(() => post(evt('x', {})), /Invalid signature/);
});

test('webhook: livemode event ignored by a test-mode server', async () => {
  const org = await makeOrg({ payout: true });
  const { store, sp } = await makeStoreWithProduct(org.id);
  const res = await orders.checkout(checkoutInput(store.slug, sp.id) as any);
  const o = res.order;
  const r = await post(evt('checkout.session.completed', { id: `cs_${o.id}`, mode: 'payment', payment_status: 'paid', payment_intent: 'pi_live', amount_total: o.totalCents, currency: 'usd', metadata: { kind: 'store_order', orderId: o.id } }, { livemode: true }));
  assert.equal(r.handled, 'ignored_livemode_mismatch');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status, 'PENDING_PAYMENT');
});

// ---------- storefront orders (Connect destination charges) ----------
test('checkout (stripe): needs a ready payout account', async () => {
  const org = await makeOrg();
  const { store, sp } = await makeStoreWithProduct(org.id);
  await assert.rejects(() => orders.checkout(checkoutInput(store.slug, sp.id) as any), /isn't set up to take payments/);
});

test('checkout (stripe): destination charge to merchant, PAID only via webhook, replay-safe', async () => {
  const org = await makeOrg({ payout: true });
  const { store, sp } = await makeStoreWithProduct(org.id, 2500);
  const res: any = await orders.checkout(checkoutInput(store.slug, sp.id, 2) as any);
  assert.match(res.checkoutUrl, /checkout\.stripe\.test/);
  const o = await prisma.order.findUniqueOrThrow({ where: { id: res.order.id } });
  assert.equal(o.status, 'PENDING_PAYMENT');
  assert.equal(o.provider, 'stripe');
  assert.equal(o.payoutAccountId, org.payoutAccountId);
  assert.equal(o.providerCheckoutId, `cs_${o.id}`);
  const co = fake.checkouts.at(-1);
  assert.equal(co.destinationAccountId, org.payoutAccountId);
  assert.equal(co.applicationFeeCents, 0, 'platform fee defaults to 0');
  assert.equal(o.totalCents, 5000);

  const session = { id: `cs_${o.id}`, mode: 'payment', payment_status: 'paid', payment_intent: 'pi_order1', amount_total: 5000, currency: 'usd', metadata: { kind: 'store_order', orderId: o.id } };
  const e1 = evt('checkout.session.completed', session);
  assert.equal((await post(e1)).handled, 'order_paid');
  const paid = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.providerPaymentId, 'pi_order1');

  // exact replay of the same event
  const again = await post(e1);
  assert.equal(again.duplicate, true);
  // different event id for the same payment (async_payment_succeeded)
  assert.equal((await post(evt('checkout.session.async_payment_succeeded', session))).handled, 'order_already_processed');
  assert.deepEqual(routed, [o.id], 'fulfillment routed exactly once');
});

test('checkout (stripe): amount mismatch never marks paid', async () => {
  const org = await makeOrg({ payout: true });
  const { store, sp } = await makeStoreWithProduct(org.id, 2500);
  const res: any = await orders.checkout(checkoutInput(store.slug, sp.id) as any);
  await assert.rejects(
    () => post(evt('checkout.session.completed', { id: `cs_${res.order.id}`, mode: 'payment', payment_status: 'paid', payment_intent: 'pi_cheap', amount_total: 1, currency: 'usd', metadata: { kind: 'store_order', orderId: res.order.id } })),
    /does not match/,
  );
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: res.order.id } })).status, 'PENDING_PAYMENT');
});

test('checkout (stripe): unpaid session (async method pending) does not mark paid; expiry cancels', async () => {
  const org = await makeOrg({ payout: true });
  const { store, sp } = await makeStoreWithProduct(org.id);
  const res: any = await orders.checkout(checkoutInput(store.slug, sp.id) as any);
  const s = { id: `cs_${res.order.id}`, mode: 'payment', payment_status: 'unpaid', amount_total: res.order.totalCents, currency: 'usd', metadata: { kind: 'store_order', orderId: res.order.id } };
  assert.equal((await post(evt('checkout.session.completed', s))).handled, 'ignored');
  await post(evt('checkout.session.expired', s));
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: res.order.id } })).status, 'CANCELLED');
});

test('checkout (stub): Phase 0 demo flow still marks PAID without keys', async () => {
  setPaymentProviderForTests(new StubPaymentProvider());
  const org = await makeOrg();
  const { store, sp } = await makeStoreWithProduct(org.id);
  const res: any = await orders.checkout(checkoutInput(store.slug, sp.id) as any);
  assert.equal(res.mode, 'stub');
  assert.equal(res.order.status, 'PAID');
  assert.equal(res.order.provider, 'stub');
  assert.match(res.checkoutUrl, /stub_paid=1/);
});

// ---------- SaaS billing ----------
test('billing (stripe): subscribe returns Checkout URL, stays inactive until webhook', async () => {
  const org = await makeOrg();
  const r: any = await billing.subscribe(org.id, 'm@example.com', 'growth');
  assert.match(r.checkoutUrl, /checkout\.stripe\.test\/growth/);
  assert.equal(await prisma.subscription.count({ where: { organizationId: org.id } }), 0);
  assert.ok((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).billingCustomerId);
});

test('billing (stripe): missing price id → clear error', async () => {
  const org = await makeOrg();
  const saved = process.env.STRIPE_PRICE_SCALE;
  delete process.env.STRIPE_PRICE_SCALE;
  await assert.rejects(() => billing.subscribe(org.id, 'm@example.com', 'scale'), /STRIPE_PRICE_SCALE is not set/);
  process.env.STRIPE_PRICE_SCALE = saved;
});

test('billing (stripe): subscription lifecycle synced from provider; replays and out-of-order events are safe', async () => {
  const org = await makeOrg();
  const subId = uid('sub');
  const base = { providerSubscriptionId: subId, providerCustomerId: 'cus_1', organizationId: org.id, priceId: 'price_growth', currentPeriodEnd: new Date(Date.now() + 864e5), cancelAtPeriodEnd: false };
  fake.subs.set(subId, { ...base, status: 'INCOMPLETE' });
  const created = evt('customer.subscription.created', { id: subId, metadata: { organizationId: org.id } });
  await post(created);
  fake.subs.set(subId, { ...base, status: 'ACTIVE' });
  await post(evt('invoice.paid', { id: 'in_1', parent: { subscription_details: { subscription: subId } } }));
  let s = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: org.id } });
  assert.equal(s.status, 'ACTIVE');
  assert.equal(s.planId, 'growth');
  assert.equal(s.provider, 'stripe');
  // a late, re-delivered "created" event can't regress the status: we re-read the provider
  const late = evt('customer.subscription.created', { id: subId, metadata: { organizationId: org.id } });
  await post(late);
  s = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: org.id } });
  assert.equal(s.status, 'ACTIVE');
  // replay of an already-processed event is skipped outright
  assert.equal((await post(created)).duplicate, true);
  fake.subs.set(subId, { ...base, status: 'PAST_DUE' });
  await post(evt('invoice.payment_failed', { id: 'in_2', subscription: subId }));
  assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { organizationId: org.id } })).status, 'PAST_DUE');
  fake.subs.set(subId, { ...base, status: 'CANCELLED' });
  await post(evt('customer.subscription.deleted', { id: subId, metadata: {} }));
  assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { organizationId: org.id } })).status, 'CANCELLED');
});

test('billing (stub): subscribe activates locally', async () => {
  setPaymentProviderForTests(new StubPaymentProvider());
  const org = await makeOrg();
  const r: any = await billing.subscribe(org.id, 'm@example.com', 'starter');
  assert.equal(r.subscription.status, 'ACTIVE');
  assert.equal(r.subscription.provider, 'stub');
});

test('handler failure leaves event unprocessed so Stripe can retry', async () => {
  const org = await makeOrg();
  const e = evt('customer.subscription.updated', { id: 'sub_missing', metadata: { organizationId: org.id } });
  await assert.rejects(() => post(e), /no such subscription/);
  const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: e.id } });
  assert.equal(row.processedAt, null);
  fake.subs.set('sub_missing', { providerSubscriptionId: 'sub_missing', providerCustomerId: null, organizationId: org.id, priceId: 'price_starter', status: 'ACTIVE', currentPeriodEnd: null, cancelAtPeriodEnd: false });
  assert.equal((await post(e)).handled, 'subscription_synced');
  assert.equal((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: e.id } })).attempts, 2);
});

// ---------- Connect Express ----------
test('connect: onboarding creates one Express account, account.updated (connect endpoint) enables charges', async () => {
  const org = await makeOrg();
  const a = await payouts.startOnboarding(org.id, 'm@example.com');
  const b = await payouts.startOnboarding(org.id, 'm@example.com');
  assert.equal(a.accountId, b.accountId, 'one account per merchant');
  assert.match(a.url, /onboard/);
  assert.equal((await payouts.status(org.id)).ready, false);
  await post(evt('account.updated', { id: a.accountId, object: 'account', charges_enabled: true, payouts_enabled: true, details_submitted: true }, { account: a.accountId }), WHSEC_CONNECT, 'connect');
  const st = await payouts.status(org.id);
  assert.equal(st.ready, true);
  assert.equal(st.payoutsEnabled, true);
});

// ---------- Ad Fuel ----------
test('ad fuel: top-up credited once from payment_intent.succeeded (replays + duplicate events)', async () => {
  const org = await makeOrg();
  const start = await fuel.startTopUp(org.id, 'm@example.com', 5000, uid('req'));
  assert.equal(start.clientSecret, 'pi_secret_x');
  const w = await fuel.wallet(org.id);
  assert.equal(w.balanceCents, 0, 'not credited before webhook');
  const pi = { id: start.paymentIntentId, object: 'payment_intent', amount: 5000, amount_received: 5000, metadata: { kind: 'ad_fuel_topup', walletId: w.id, organizationId: org.id } };
  const e = evt('payment_intent.succeeded', pi);
  assert.equal((await post(e)).handled, 'fuel_credited');
  assert.equal((await post(e)).duplicate, true);
  assert.equal((await post(evt('payment_intent.succeeded', pi))).handled, 'fuel_duplicate');
  assert.equal((await fuel.wallet(org.id)).balanceCents, 5000);
});

test('ad fuel: top-up bounds enforced', async () => {
  const org = await makeOrg();
  await assert.rejects(() => fuel.startTopUp(org.id, 'm@example.com', 999, uid('req')), /between/);
  await assert.rejects(() => fuel.startTopUp(org.id, 'm@example.com', 500001, uid('req')), /between/);
});

test('ad fuel: refund unspent fuel; caps; failed refund restores fuel exactly once', async () => {
  const org = await makeOrg();
  const w = await fuel.wallet(org.id);
  const piId = uid('pi');
  await fuel.creditTopUp({ paymentIntentId: piId, amountCents: 4000, walletId: w.id, provider: 'stripe' });
  const topup = await prisma.walletTxn.findFirstOrThrow({ where: { walletId: w.id, kind: 'TOPUP' } });
  // simulate $10 spent
  await prisma.adWallet.update({ where: { id: w.id }, data: { balanceCents: 3000 } });
  await assert.rejects(() => fuel.refundTopUp(org.id, topup.id, 3500), /Only unspent fuel/);
  const r = await fuel.refundTopUp(org.id, topup.id, 1000);
  assert.equal(fake.refunds.at(-1)!.paymentId, piId);
  assert.match(fake.refunds.at(-1)!.idempotencyKey, /^sf-fuelrefund-/);
  assert.equal((await fuel.wallet(org.id)).balanceCents, 2000);
  assert.equal((await fuel.refundable(topup.id)).remaining, 3000);
  // refund fails later → fuel back, once
  const rf = evt('refund.failed', { id: r.refundId, object: 'refund', status: 'failed', metadata: { kind: 'ad_fuel_refund' } });
  await post(rf);
  await post(evt('refund.updated', { id: r.refundId, object: 'refund', status: 'failed', metadata: { kind: 'ad_fuel_refund' } }));
  assert.equal((await fuel.wallet(org.id)).balanceCents, 3000);
  assert.equal((await fuel.refundable(topup.id)).remaining, 4000);
  // other orgs can't refund this top-up
  const other = await makeOrg();
  await assert.rejects(() => fuel.refundTopUp(other.id, topup.id, 100), /not found/);
});

test('ad fuel (stub): top-up credits immediately, no network', async () => {
  setPaymentProviderForTests(new StubPaymentProvider());
  const org = await makeOrg();
  await fuel.startTopUp(org.id, 'm@example.com', 2000, uid('req'));
  assert.equal((await fuel.wallet(org.id)).balanceCents, 2000);
});

test('billing plans expose the platform fee from PLATFORM_FEE_BPS (billing page reads it)', async () => {
  delete process.env.PLATFORM_FEE_BPS;
  assert.equal((await billing.listPlans()).platformFeeBps, 0);
  process.env.PLATFORM_FEE_BPS = '125';
  assert.equal((await billing.listPlans()).platformFeeBps, 125);
  process.env.PLATFORM_FEE_BPS = '99999';
  assert.equal((await billing.listPlans()).platformFeeBps, 2000);
  delete process.env.PLATFORM_FEE_BPS;
});
