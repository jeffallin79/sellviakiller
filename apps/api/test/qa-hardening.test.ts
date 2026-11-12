// QA round 1 (2026-11-12) regression tests: webhook concurrency, mismatch handling,
// Ad Fuel refund timeouts + reconciler, wallet CHECK constraint, disputes.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@storeforge/db';
import { setPaymentProviderForTests } from '../src/payments';
import { OrdersService } from '../src/orders/orders.service';
import { BillingService } from '../src/billing/billing.service';
import { FuelService } from '../src/payments/fuel.service';
import { PayoutsService } from '../src/payments/payouts.service';
import { WebhookProcessorService } from '../src/payments/webhook-processor.service';
import { NotificationsService } from '../src/payments/notifications.service';
import { DisputesService } from '../src/payments/disputes.service';
import { EmailService } from '../src/email/email.service';
import { RefundsService } from '../src/orders/refunds.service';
import { StripeWebhooksController } from '../src/payments/payments.controller';
import { FakeStripeProvider, WHSEC, WHSEC_CONNECT, signed, evt, makeOrg, seedPlans, makeStoreWithProduct, checkoutInput, uid } from './helpers';

let routed: string[] = [];
// Slow fake fulfillment widens the race window the way a real supplier call would.
const fulfillment = { routeOrder: async (id: string) => { routed.push(id); await new Promise((r) => setTimeout(r, 20)); return {} as any; } } as any;
const emails = new EmailService();
const orders = new OrdersService(fulfillment, emails);
const fuel = new FuelService();
const notifications = new NotificationsService();
const processor = new WebhookProcessorService(orders, new BillingService(), fuel, new PayoutsService(), new DisputesService(notifications), notifications, new RefundsService(emails));
const controller = new StripeWebhooksController(processor);
let fake: FakeStripeProvider;

const post = (event: object) => {
  const { raw, header } = signed(event, WHSEC);
  return controller.platform({ rawBody: raw } as any, header);
};

before(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = WHSEC_CONNECT;
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

async function pendingOrder() {
  const org = await makeOrg({ payout: true });
  const { store, sp } = await makeStoreWithProduct(org.id, 2500);
  const res: any = await orders.checkout(checkoutInput(store.slug, sp.id, 2) as any);
  const o = await prisma.order.findUniqueOrThrow({ where: { id: res.order.id } });
  const session = { id: `cs_${o.id}`, mode: 'payment', payment_status: 'paid', payment_intent: uid('pi'), amount_total: o.totalCents, currency: 'usd', metadata: { kind: 'store_order', orderId: o.id } };
  return { org, store, o, session };
}

// ---------- 1. webhook / fulfillment race ----------
test('race: 8 concurrent identical deliveries → one dispatch, one fulfillment, all 2xx', async () => {
  const { o, session } = await pendingOrder();
  const e = evt('checkout.session.completed', session);
  const results = await Promise.all(Array.from({ length: 8 }, () => post(e)));
  assert.equal(results.filter((r) => r.handled === 'order_paid').length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r.duplicate).length, 7);
  assert.ok(results.every((r) => r.received === true));
  assert.deepEqual(routed, [o.id], 'fulfillment routed exactly once');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status, 'PAID');
  const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: e.id } });
  assert.ok(row.processedAt);
  assert.equal(row.lockedUntil, null);
});

test('race: completed + async_payment_succeeded together (x4 each) → exactly one fulfillment', async () => {
  const { o, session } = await pendingOrder();
  const a = evt('checkout.session.completed', session);
  const b = evt('checkout.session.async_payment_succeeded', session);
  const results = await Promise.all([a, b, a, b, a, b, a, b].map((e) => post(e)));
  assert.equal(results.filter((r) => r.handled === 'order_paid').length, 1, JSON.stringify(results));
  assert.deepEqual(routed, [o.id]);
});

test('race: markPaid called concurrently transitions once', async () => {
  const { o } = await pendingOrder();
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => orders.markPaid(o.id, 'pi_same', 'stripe')));
  assert.equal(rs.filter((r) => r.transitioned).length, 1);
  assert.deepEqual(routed, [o.id]);
});

// ---------- 3. mismatch stays unresolved, alerts, retryable ----------
test('mismatch: amount/checkout mismatch → non-2xx, event unprocessed + retryable, order flagged, alerts raised', async () => {
  const { org, o, session } = await pendingOrder();
  const e = evt('checkout.session.completed', { ...session, amount_total: 1 });
  await assert.rejects(() => post(e), (err: any) => err.getStatus?.() === 409 && /does not match/.test(err.message));
  let row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: e.id } });
  assert.equal(row.processedAt, null, 'not marked processed');
  assert.equal(row.lockedUntil, null, 'unlocked so Stripe retries can re-claim');
  assert.match(row.lastError!, /does not match/);
  const flagged = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.equal(flagged.status, 'PENDING_PAYMENT');
  assert.equal(flagged.flag, 'payment_mismatch');
  assert.match(flagged.flagDetail!, /paid 1 USD/);
  assert.equal(await prisma.notification.count({ where: { organizationId: org.id, kind: 'payment_mismatch' } }), 1);
  assert.equal(await prisma.notification.count({ where: { organizationId: null, kind: 'payment_mismatch', orderId: o.id } }), 1);
  // Stripe retry: re-claimed and still refused (no duplicate alerts)
  await assert.rejects(() => post(e), /does not match/);
  row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: e.id } });
  assert.equal(row.attempts, 2);
  assert.equal(await prisma.notification.count({ where: { orderId: o.id, kind: 'payment_mismatch' } }), 2);
  // wrong checkout id also refused
  await assert.rejects(() => post(evt('checkout.session.completed', { ...session, id: 'cs_other' })), /does not match/);
  assert.deepEqual(routed, []);
});

// ---------- 4. Ad Fuel refund timeouts + reconciler ----------
async function fundedWallet(amount = 4000) {
  const org = await makeOrg();
  const w = await fuel.wallet(org.id);
  await fuel.creditTopUp({ paymentIntentId: uid('pi'), amountCents: amount, walletId: w.id, provider: 'stripe' });
  const topup = await prisma.walletTxn.findFirstOrThrow({ where: { walletId: w.id, kind: 'TOPUP' } });
  return { org, w, topup };
}
const timeout = () => Object.assign(new Error('Request timed out'), { type: 'StripeConnectionError' });
const age = (txnId: string) => prisma.walletTxn.update({ where: { id: txnId }, data: { createdAt: new Date(Date.now() - 3600_000), reconciledAt: new Date(Date.now() - 3600_000) } });

test('fuel refund: Stripe accepted but call timed out → fuel stays reserved; reconciler confirms success, no restore, no second refund', async () => {
  const { org, w, topup } = await fundedWallet();
  fake.refundStatus = 'pending';
  fake.refundFailure = { error: timeout(), created: true };
  const r = await fuel.refundTopUp(org.id, topup.id, 1500);
  assert.equal(r.status, 'unknown');
  assert.equal((await fuel.wallet(org.id)).balanceCents, 2500, 'not restored blindly');
  const txn = await prisma.walletTxn.findFirstOrThrow({ where: { walletId: w.id, kind: 'REFUND' } });
  assert.equal(txn.status, 'unknown');
  // Stripe finishes the refund; reconciler finds it by metadata (no second create)
  for (const v of fake.stripeRefunds.values()) v.status = 'succeeded';
  await age(txn.id);
  const out = await fuel.reconcilePendingRefunds();
  assert.equal(out.find((x) => x.txnId === txn.id)?.result, 'succeeded');
  assert.equal(fake.refunds.length, 1, 'refund created once');
  assert.equal(fake.stripeRefunds.size, 1);
  const done = await prisma.walletTxn.findUniqueOrThrow({ where: { id: txn.id } });
  assert.equal(done.status, 'succeeded');
  assert.ok(done.providerRefundId);
  assert.equal((await fuel.wallet(org.id)).balanceCents, 2500);
  assert.equal(await prisma.walletTxn.count({ where: { walletId: w.id, kind: 'ADJUST' } }), 0);
});

test('fuel refund: timed out before Stripe created it → reconciler re-submits with the same key; confirmed failure restores once', async () => {
  const { org, w, topup } = await fundedWallet();
  fake.refundFailure = { error: timeout(), created: false };
  await fuel.refundTopUp(org.id, topup.id, 1000);
  assert.equal((await fuel.wallet(org.id)).balanceCents, 3000);
  const txn = await prisma.walletTxn.findFirstOrThrow({ where: { walletId: w.id, kind: 'REFUND' } });
  await age(txn.id);
  fake.refundStatus = 'failed';
  await fuel.reconcilePendingRefunds();
  assert.equal(fake.refunds.length, 2);
  assert.equal(fake.refunds[0].idempotencyKey, fake.refunds[1].idempotencyKey, 'same idempotency key on retry');
  assert.equal((await fuel.wallet(org.id)).balanceCents, 4000, 'restored after confirmed failure');
  await fuel.reconcilePendingRefunds();
  const again = await prisma.walletTxn.findUniqueOrThrow({ where: { id: txn.id } });
  await fuel.applyRefundStatus(again.providerRefundId!, 'failed');
  assert.equal((await fuel.wallet(org.id)).balanceCents, 4000, 'restored exactly once');
});

test('fuel refund: definitive 4xx rejection restores immediately, exactly once', async () => {
  const { org, w, topup } = await fundedWallet();
  fake.refundFailure = { error: Object.assign(new Error('Charge already refunded'), { type: 'StripeInvalidRequestError', statusCode: 400 }), created: false };
  await assert.rejects(() => fuel.refundTopUp(org.id, topup.id, 1000), /declined/);
  assert.equal((await fuel.wallet(org.id)).balanceCents, 4000);
  assert.equal(await prisma.walletTxn.count({ where: { walletId: w.id, kind: 'ADJUST' } }), 1);
  assert.equal((await prisma.walletTxn.findFirstOrThrow({ where: { walletId: w.id, kind: 'REFUND' } })).status, 'failed');
});

// ---------- 5. CHECK constraint ----------
test('wallet: database refuses a negative balance', async () => {
  const { w } = await fundedWallet(1000);
  await assert.rejects(() => prisma.adWallet.update({ where: { id: w.id }, data: { balanceCents: { decrement: 1001 } } }), /AdWallet_balance_nonnegative|check constraint/i);
  await assert.rejects(() => prisma.adWallet.update({ where: { id: w.id }, data: { bonusCents: -1 } }), /AdWallet_bonus_nonnegative|check constraint/i);
  assert.equal((await prisma.adWallet.findUniqueOrThrow({ where: { id: w.id } })).balanceCents, 1000);
});

// ---------- 11. disputes ----------
test('disputes: created → recorded, order + store flagged, merchant + platform alerted; replay-safe; won clears, lost flags', async () => {
  const { org, store, o, session } = await pendingOrder();
  await post(evt('checkout.session.completed', session));
  const dp = { id: uid('dp'), object: 'dispute', charge: uid('ch'), payment_intent: session.payment_intent, amount: o.totalCents, currency: 'usd', reason: 'fraudulent', status: 'needs_response', evidence_details: { due_by: Math.floor(Date.now() / 1000) + 7 * 86400 } };
  const created = evt('charge.dispute.created', dp);
  assert.equal((await post(created)).handled, 'dispute_recorded');
  await post(created); // replay
  await post(evt('charge.dispute.created', dp)); // same dispute, new event id
  const d = await prisma.dispute.findUniqueOrThrow({ where: { providerDisputeId: dp.id } });
  assert.equal(d.orderId, o.id);
  assert.equal(d.organizationId, org.id);
  assert.equal(d.status, 'needs_response');
  let ord = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.equal(ord.flag, 'dispute_open');
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: store.id } })).riskFlag, 'open_disputes:1');
  assert.equal(await prisma.notification.count({ where: { organizationId: org.id, kind: 'dispute_opened' } }), 1);
  assert.equal(await prisma.notification.count({ where: { organizationId: null, kind: 'dispute_opened', orderId: o.id } }), 1);

  await post(evt('charge.dispute.updated', { ...dp, status: 'under_review' }));
  assert.equal((await prisma.dispute.findUniqueOrThrow({ where: { providerDisputeId: dp.id } })).status, 'under_review');
  await post(evt('charge.dispute.closed', { ...dp, status: 'won' }));
  ord = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.equal(ord.flag, null);
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: store.id } })).riskFlag, null);
  assert.ok((await prisma.dispute.findUniqueOrThrow({ where: { providerDisputeId: dp.id } })).closedAt);

  const dp2 = { ...dp, id: uid('dp') };
  await post(evt('charge.dispute.created', dp2));
  await post(evt('charge.dispute.closed', { ...dp2, status: 'lost' }));
  ord = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.equal(ord.flag, 'dispute_lost');
  assert.equal(await prisma.notification.count({ where: { organizationId: org.id, kind: 'dispute_closed' } }), 2);
});

test('disputes: unknown payment still recorded + platform alert', async () => {
  const dp = { id: uid('dp'), charge: uid('ch'), payment_intent: uid('pi'), amount: 999, currency: 'usd', reason: 'general', status: 'warning_needs_response' };
  await post(evt('charge.dispute.created', dp));
  const d = await prisma.dispute.findUniqueOrThrow({ where: { providerDisputeId: dp.id } });
  assert.equal(d.orderId, null);
  assert.equal(await prisma.notification.count({ where: { organizationId: null, dedupeKey: { startsWith: `p:${dp.id}` } } }), 1);
});
