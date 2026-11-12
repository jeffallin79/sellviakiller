// Phase 1 slice 2: order emails (confirmation, shipped with tracking, delivered, refund), dedupe,
// transports, brand palette; merchant refunds (idempotency, over-refund, failure release).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '@storeforge/db';
import { setPaymentProviderForTests } from '../src/payments';
import { OrdersService } from '../src/orders/orders.service';
import { RefundsService } from '../src/orders/refunds.service';
import { FulfillmentService } from '../src/fulfillment/fulfillment.service';
import { SuppliersService } from '../src/suppliers/suppliers.service';
import { BillingService } from '../src/billing/billing.service';
import { FuelService } from '../src/payments/fuel.service';
import { PayoutsService } from '../src/payments/payouts.service';
import { WebhookProcessorService } from '../src/payments/webhook-processor.service';
import { NotificationsService } from '../src/payments/notifications.service';
import { DisputesService } from '../src/payments/disputes.service';
import { StripeWebhooksController } from '../src/payments/payments.controller';
import { EmailService, fromHeader } from '../src/email/email.service';
import { renderOrderEmail, trackingUrl } from '../src/email/templates';
import { emailPalette, parseRootTokens } from '../src/email/palette';
import { ResendTransport, OutboxTransport, PermanentEmailError, setEmailTransportForTests, type EmailTransport, type OutgoingEmail } from '../src/email/transport';
import { FakeStripeProvider, WHSEC, WHSEC_CONNECT, signed, evt, makeOrg, seedPlans, makeStoreWithProduct, checkoutInput, uid } from './helpers';

class MemoryTransport implements EmailTransport {
  readonly kind = 'outbox' as const;
  sent: OutgoingEmail[] = [];
  failNext: Error | null = null;
  async send(m: OutgoingEmail) {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.sent.push(m);
    return { providerMessageId: `mem_${this.sent.length}` };
  }
}

const emails = new EmailService();
const suppliers = new SuppliersService();
const fulfillment = new FulfillmentService(suppliers, emails);
const orders = new OrdersService(fulfillment, emails);
const refunds = new RefundsService(emails);
const notifications = new NotificationsService();
const processor = new WebhookProcessorService(orders, new BillingService(), new FuelService(), new PayoutsService(), new DisputesService(notifications), notifications, refunds);
const webhooks = new StripeWebhooksController(processor);
const post = (e: object) => { const { raw, header } = signed(e, WHSEC); return webhooks.platform({ rawBody: raw } as any, header); };
let mail: MemoryTransport;

before(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = WHSEC_CONNECT;
  await seedPlans();
});
beforeEach(() => { mail = new MemoryTransport(); setEmailTransportForTests(mail); setPaymentProviderForTests(null); });
after(async () => { setEmailTransportForTests(null); setPaymentProviderForTests(null); await prisma.$disconnect(); });

const kinds = async (orderId: string) => (await prisma.emailMessage.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })).map((m) => m.kind);

/** Stub-pay checkout (paid immediately). Store set to manual approval so we control fulfillment. */
async function paidStubOrder(qty = 2) {
  const org = await makeOrg();
  await prisma.user.create({ data: { id: uid('u'), email: `${uid('owner')}@merchant.test`, name: 'Owner', accounts: undefined, memberships: { create: { organizationId: org.id, role: 'OWNER' } } } as any }).catch(() => null);
  const { store, sp } = await makeStoreWithProduct(org.id, 2500);
  await prisma.store.update({ where: { id: store.id }, data: { name: 'Juniper <Goods>', autoFulfill: false } as any }).catch(() =>
    prisma.store.update({ where: { id: store.id }, data: { name: 'Juniper <Goods>' } }));
  const res: any = await orders.checkout({ ...checkoutInput(store.slug, sp.id, qty), name: 'Ada <script>' } as any);
  await emails.idle(); // delivery is background since QA round 2 (#1); wait before asserting on it
  return { org, store, orderId: res.order.id as string };
}

// ---------- palette / rendering ----------
test('palette: email colours come from packages/ui/tokens.css', () => {
  const css = readFileSync(require.resolve('@storeforge/ui/tokens.css'), 'utf8');
  const t = parseRootTokens(css);
  const p = emailPalette();
  assert.equal(p.brand, t['brand']);
  assert.equal(p.canvas, t['canvas']);
  assert.equal(p.money, t['money']);
  for (const v of Object.values(p)) assert.match(v, /^#[0-9A-F]{6}$/);
  assert.deepEqual(parseRootTokens(':root{--sf-a: 1 2 3; --sf-b: var(--sf-a);} .dark{--sf-a: 9 9 9;}'), { a: '#010203', b: '#010203' });
});

test('render: branded, escaped, only palette colours, no CSS variables', () => {
  const p = emailPalette();
  const ctx: any = {
    store: { name: 'Juniper & <Co>', shopUrl: 'https://shop.example.com/?t=1&u=2' },
    order: { id: 'o1', number: 'AB12CD34', createdAt: new Date('2026-11-10T12:00:00Z'), customerName: 'Ada <img src=x>', currency: 'usd',
      lines: [{ title: 'Lamp "Deluxe" <b>', quantity: 2, unitPriceCents: 2500 }], subtotalCents: 5000, shippingCents: 0, totalCents: 5000, refundedCents: 0,
      shipTo: ['Ada', '1 Main', 'Regina SK S4P', 'CA'], eta: { minDays: 7, maxDays: 12 } },
    tracking: { carrier: 'USPS', number: '9400 1000 0000', url: trackingUrl('USPS', '9400 1000 0000') },
  };
  const r = renderOrderEmail('ORDER_SHIPPED', ctx);
  assert.match(r.subject, /shipped/i);
  assert.ok(!r.html.includes('<img src=x>') && !r.html.includes('<b>') && r.html.includes('&lt;Co&gt;'));
  assert.ok(!/var\(--/.test(r.html), 'no CSS variables in email');
  const used = new Set((r.html.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((h) => h.toUpperCase()));
  const allowed = new Set(Object.values(p));
  assert.deepEqual([...used].filter((h) => !allowed.has(h)), [], 'every colour is a brand token');
  assert.ok(used.has(p.brand) && used.has(p.band), 'garnet CTA + ink band');
  assert.ok(r.html.includes('9400 1000 0000') && r.html.includes('tools.usps.com'));
  assert.ok(r.text.includes('9400 1000 0000') && r.text.includes('https://tools.usps.com'));
  assert.ok(renderOrderEmail('ORDER_CONFIRMED', ctx).html.includes('href="https://shop.example.com/?t=1&amp;u=2"'), 'attribute-escaped link');
  assert.equal(trackingUrl('UPS', '1Z999'), 'https://www.ups.com/track?tracknum=1Z999');
  assert.match(trackingUrl('YunExpress', 'YT1'), /yuntrack/);
  assert.match(trackingUrl('Mystery Post', 'AB 1'), /17track\.net.*AB%201/);
  assert.equal(fromHeader('Juniper "Goods"\r\nBcc: x'), '"Juniper GoodsBcc: x" <orders@storeforge.local>');
});

// ---------- triggers ----------
test('trigger: confirmation on paid — exactly once, even if markPaid is replayed', async () => {
  const { orderId, store } = await paidStubOrder();
  assert.deepEqual(await kinds(orderId), ['ORDER_CONFIRMED']);
  await orders.markPaid(orderId, `stub_payment_${orderId.slice(-8)}`, 'stub');
  await Promise.all([1, 2, 3].map(() => emails.orderEvent('ORDER_CONFIRMED', orderId)));
  assert.deepEqual(await kinds(orderId), ['ORDER_CONFIRMED']);
  await emails.idle();
  assert.equal(mail.sent.length, 1);
  const m = mail.sent[0];
  assert.equal(m.to, 'buyer@example.com');
  assert.match(m.from, /^"Juniper Goods" </);
  assert.match(m.subject, /confirmed/i);
  assert.ok(m.html.includes('Ada &lt;script&gt;'));
  assert.ok(m.html.includes(`${store.slug}.storeforge.local`), 'links back to the shop');
  assert.equal(m.idempotencyKey, `sf-email-${(await prisma.emailMessage.findFirstOrThrow({ where: { orderId } })).id}`);
  const row = await prisma.emailMessage.findFirstOrThrow({ where: { orderId } });
  assert.equal(row.status, 'SENT');
  assert.equal(row.transport, 'outbox');
});

test('trigger: confirmation via Stripe webhook — replays and both events send one email', async () => {
  const fake = new FakeStripeProvider();
  setPaymentProviderForTests(fake);
  const org = await makeOrg({ payout: true });
  const { store, sp } = await makeStoreWithProduct(org.id, 2500);
  const res: any = await orders.checkout(checkoutInput(store.slug, sp.id, 1) as any);
  assert.deepEqual(await kinds(res.order.id), [], 'nothing before payment');
  assert.match(fake.checkouts.at(-1).successUrl, new RegExp(`^http://${store.slug}\\.storeforge\\.local:3000/checkout/complete`));
  const o = await prisma.order.findUniqueOrThrow({ where: { id: res.order.id } });
  const session = { id: `cs_${o.id}`, mode: 'payment', payment_status: 'paid', payment_intent: uid('pi'), amount_total: o.totalCents, currency: 'usd', metadata: { kind: 'store_order', orderId: o.id } };
  const a = evt('checkout.session.completed', session);
  const b = evt('checkout.session.async_payment_succeeded', session);
  await Promise.all([post(a), post(a), post(b)]);
  assert.deepEqual(await kinds(o.id), ['ORDER_CONFIRMED']);
});

test('trigger: shipped email with tracking number + carrier link, once; then delivered', async () => {
  const { orderId } = await paidStubOrder();
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status === 'AWAITING_MERCHANT_APPROVAL' || order.status === 'PAID') await fulfillment.approveAndSubmit(orderId);
  const f = await prisma.fulfillment.findUniqueOrThrow({ where: { orderId } });
  assert.ok(f.trackingNumber);
  await fulfillment.pollTracking(f.id);
  await fulfillment.pollTracking(f.id);
  assert.deepEqual(await kinds(orderId), ['ORDER_CONFIRMED', 'ORDER_SHIPPED']);
  await emails.idle();
  const shipped = mail.sent.find((m) => /shipped/i.test(m.subject))!;
  assert.ok(shipped.html.includes(f.trackingNumber!), 'tracking number in email');
  assert.ok(shipped.html.includes(trackingUrl(f.carrier, f.trackingNumber!).replace(/&/g, '&amp;')), 'carrier tracking link');
  assert.ok(shipped.text.includes(f.trackingNumber!));

  const cj = suppliers.get('cj');
  const orig = cj.getTracking.bind(cj);
  cj.getTracking = async (id: string) => ({ ...(await orig(id)), status: 'delivered' });
  try {
    await fulfillment.pollTracking(f.id);
    await fulfillment.pollTracking(f.id);
  } finally { cj.getTracking = orig; }
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status, 'DELIVERED');
  assert.deepEqual(await kinds(orderId), ['ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_DELIVERED']);
});

test('trigger: partial then full refund — one email each, amounts shown, order → REFUNDED, no more fulfillment', async () => {
  const { org, orderId } = await paidStubOrder(2); // 5000 cents
  const r1 = await refunds.create(org.id, orderId, { amountCents: 1500, reason: 'Damaged', requestId: 'req-partial-1' });
  assert.equal(r1.status, 'succeeded');
  assert.equal((await refunds.create(org.id, orderId, { amountCents: 1500, requestId: 'req-partial-1' })).id, r1.id, 'same requestId → same refund');
  let o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(o.refundedCents, 1500);
  assert.notEqual(o.status, 'REFUNDED');
  await assert.rejects(() => refunds.create(org.id, orderId, { amountCents: o.totalCents, requestId: 'req-too-much' }), /At most 3500 cents/);
  const r2 = await refunds.create(org.id, orderId, { requestId: 'req-rest' });
  assert.equal(r2.amountCents, 3500);
  o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(o.status, 'REFUNDED');
  assert.equal(o.refundedCents, 5000);
  const ks = await kinds(orderId);
  assert.equal(ks.filter((k) => k === 'ORDER_REFUNDED').length, 2);
  await emails.idle();
  const refundMails = mail.sent.filter((m) => /refund/i.test(m.subject));
  assert.ok(refundMails[0].html.includes('$15.00'));
  assert.ok(refundMails[1].html.includes('$35.00'));
  await assert.rejects(() => refunds.create(org.id, orderId, { requestId: 'req-again' }), /Only paid orders|Nothing left/);
  await assert.rejects(() => fulfillment.approveAndSubmit(orderId), /refunded order/);
  const other = await makeOrg();
  await assert.rejects(() => refunds.create(other.id, orderId, { requestId: 'req-x1234' }), /Order not found/);
});

test('refund: concurrent requests can never refund more than was paid', async () => {
  const { org, orderId } = await paidStubOrder(2);
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => refunds.create(org.id, orderId, { amountCents: 2000, requestId: `req-conc-${i}` })));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 2, 'only 2 × 2000 fit in 5000');
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(o.refundedCents, 4000);
});

test('refund (Stripe): pending until webhook; replayed webhook sends one email; failure releases the amount', async () => {
  const fake = new FakeStripeProvider();
  setPaymentProviderForTests(fake);
  const org = await makeOrg({ payout: true });
  const { store, sp } = await makeStoreWithProduct(org.id, 2500);
  const res: any = await orders.checkout(checkoutInput(store.slug, sp.id, 2) as any);
  const o0 = await prisma.order.findUniqueOrThrow({ where: { id: res.order.id } });
  await orders.markPaid(o0.id, uid('pi'), 'stripe', `cs_${o0.id}`);

  const r = await refunds.create(org.id, o0.id, { amountCents: 1000, requestId: 'req-stripe-1' });
  assert.equal(r.status, 'pending');
  assert.equal(fake.refunds.at(-1)!.idempotencyKey, `sf-orderrefund-${r.id}`);
  assert.equal((fake.refunds.at(-1) as any).reverseTransfer, true, 'merchant share is pulled back from the connected account');
  assert.equal((await kinds(o0.id)).filter((k) => k === 'ORDER_REFUNDED').length, 0);
  const done = evt('refund.updated', { id: r.providerRefundId, object: 'refund', status: 'succeeded', metadata: { kind: 'store_order_refund', orderRefundId: r.id } });
  await Promise.all([post(done), post(done), post({ ...done, id: uid('evt') })]);
  assert.equal((await kinds(o0.id)).filter((k) => k === 'ORDER_REFUNDED').length, 1);

  const r2 = await refunds.create(org.id, o0.id, { amountCents: 2000, requestId: 'req-stripe-2' });
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: o0.id } })).refundedCents, 3000);
  await post(evt('refund.failed', { id: r2.providerRefundId, object: 'refund', status: 'failed', metadata: { kind: 'store_order_refund', orderRefundId: r2.id } }));
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: o0.id } })).refundedCents, 1000, 'reservation released');
  assert.equal((await prisma.orderRefund.findUniqueOrThrow({ where: { id: r2.id } })).status, 'failed');

  // declined outright by Stripe (4xx) → released immediately, merchant sees why
  fake.refundFailure = { error: Object.assign(new Error('charge already refunded'), { type: 'StripeInvalidRequestError', statusCode: 400 }), created: false };
  await assert.rejects(() => refunds.create(org.id, o0.id, { amountCents: 500, requestId: 'req-stripe-3' }), /declined/);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: o0.id } })).refundedCents, 1000);
  // timeout after Stripe created it → 'unknown', then found by metadata on retry submit
  fake.refundFailure = { error: new Error('socket hang up'), created: true };
  const r4 = await refunds.create(org.id, o0.id, { amountCents: 500, requestId: 'req-stripe-4' });
  assert.equal(r4.status, 'unknown');
  const again = await refunds.submit(r4.id);
  assert.equal(fake.stripeRefunds.size, 3, 'no second Stripe refund created');
  assert.equal(again.status, 'pending');
});

test('refund failing after success flags the order for the merchant', async () => {
  const fake = new FakeStripeProvider();
  fake.refundStatus = 'succeeded';
  setPaymentProviderForTests(fake);
  const org = await makeOrg({ payout: true });
  const { store, sp } = await makeStoreWithProduct(org.id, 2500);
  const res: any = await orders.checkout(checkoutInput(store.slug, sp.id, 1) as any);
  await orders.markPaid(res.order.id, uid('pi'), 'stripe', `cs_${res.order.id}`);
  const r = await refunds.create(org.id, res.order.id, { requestId: 'req-late-fail' });
  assert.equal(r.status, 'succeeded');
  await post(evt('refund.failed', { id: r.providerRefundId, object: 'refund', status: 'failed', metadata: { kind: 'store_order_refund', orderRefundId: r.id } }));
  const o = await prisma.order.findUniqueOrThrow({ where: { id: res.order.id } });
  assert.equal(o.flag, 'refund_failed');
  assert.equal(o.refundedCents, 0);
});

// ---------- delivery / transports ----------
test('send: transient failure keeps it queued (order unaffected), retry sends; permanent → FAILED', async () => {
  mail.failNext = new Error('ECONNRESET');
  const { org, orderId } = await paidStubOrder();
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status !== 'PENDING_PAYMENT', true, 'order still paid');
  let m = await prisma.emailMessage.findFirstOrThrow({ where: { orderId } });
  assert.equal(m.status, 'QUEUED');
  assert.equal(m.attempts, 1);
  assert.match(m.lastError!, /ECONNRESET/);
  m = await emails.retry(org.id, m.id);
  assert.equal(m.status, 'SENT');
  assert.equal(m.attempts, 2);
  await emails.retry(org.id, m.id);
  assert.equal(mail.sent.length, 1, 'retrying a SENT email is a no-op');

  mail.failNext = new PermanentEmailError('422 invalid to address');
  const second = await paidStubOrder();
  const m2 = await prisma.emailMessage.findFirstOrThrow({ where: { orderId: second.orderId } });
  assert.equal(m2.status, 'FAILED');
  const other = await makeOrg();
  await assert.rejects(() => emails.retry(other.id, m2.id), /Email not found/);
});

test('ResendTransport: auth, idempotency key, payload; 4xx is permanent, 5xx retryable', async () => {
  const calls: any[] = [];
  let status = 200;
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(status === 200 ? JSON.stringify({ id: 're_msg_1' }) : JSON.stringify({ message: 'nope' }), { status });
  }) as any;
  const t = new ResendTransport('re_test_key', fetchImpl);
  const msg: OutgoingEmail = { id: 'e1', from: '"Shop" <orders@mail.example.com>', to: 'a@b.co', replyTo: 'owner@shop.co', subject: 'Hi', html: '<p>x</p>', text: 'x', idempotencyKey: 'sf-email-e1', tags: { kind: 'ORDER_CONFIRMED' } };
  assert.deepEqual(await t.send(msg), { providerMessageId: 're_msg_1' });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test_key');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'sf-email-e1');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.from, msg.from);
  assert.deepEqual(body.to, ['a@b.co']);
  assert.equal(body.reply_to, 'owner@shop.co');
  assert.equal(body.text, 'x');
  status = 422;
  await assert.rejects(() => t.send(msg), PermanentEmailError);
  status = 429;
  await assert.rejects(() => t.send(msg), (e: any) => !(e instanceof PermanentEmailError));
  status = 503;
  await assert.rejects(() => t.send(msg), (e: any) => !(e instanceof PermanentEmailError));
});

test('OutboxTransport (dev): writes .html + .json per message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-outbox-'));
  const t = new OutboxTransport(dir);
  await t.send({ id: 'e2', from: 'f', to: 't@x.co', subject: 'S', html: '<b>hi</b>', text: 'hi', idempotencyKey: 'k' });
  const files = readdirSync(dir).sort();
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => f.endsWith('.html')) && files.some((f) => f.endsWith('.json')));
  const json = JSON.parse(readFileSync(join(dir, files.find((f) => f.endsWith('.json'))!), 'utf8'));
  assert.equal(json.to, 't@x.co');
});
