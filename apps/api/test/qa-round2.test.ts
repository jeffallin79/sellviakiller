// QA round 2 (slice 2 conditional): crash-safe paid → fulfilment → email, outbox sweeper, refund
// reconciler, TLS config / pinned probe, header CR/LF, refundedCents CHECK.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { prisma } from '@storeforge/db';
import { setPaymentProviderForTests } from '../src/payments';
import { SuppliersService } from '../src/suppliers/suppliers.service';
import { FulfillmentService } from '../src/fulfillment/fulfillment.service';
import { OrdersService } from '../src/orders/orders.service';
import { RefundsService } from '../src/orders/refunds.service';
import { EmailService, headerLine } from '../src/email/email.service';
import { setEmailTransportForTests, type EmailTransport, type OutgoingEmail } from '../src/email/transport';
import { assertTlsConfig, isBlockedAddress, probeHttps, setTlsForTests, type TlsProvider, type TlsState } from '../src/domains/tls';
import { setDnsForTests, type DnsLookup, type DnsSnapshot } from '../src/domains/dns';
import { DomainsService } from '../src/domains/domains.service';
import { DomainsController } from '../src/domains/domains.controller';
import { txtValue } from '../src/domains/host';
import { FakeStripeProvider, makeOrg, makeStoreWithProduct, checkoutInput, uid } from './helpers';

class MemoryTransport implements EmailTransport {
  readonly kind = 'outbox' as const;
  sent: OutgoingEmail[] = [];
  delayMs = 0;
  async send(m: OutgoingEmail) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.sent.push(m);
    return { providerMessageId: `mem_${this.sent.length}` };
  }
}

const emails = new EmailService();
const fulfillment = new FulfillmentService(new SuppliersService(), emails);
const orders = new OrdersService(fulfillment, emails);
const refunds = new RefundsService(emails);
let mail: MemoryTransport;
const later = (ms: number) => new Date(Date.now() + ms);

beforeEach(() => { mail = new MemoryTransport(); setEmailTransportForTests(mail); setPaymentProviderForTests(null); });
after(async () => { await emails.idle(); setEmailTransportForTests(null); setPaymentProviderForTests(null); setTlsForTests(null); setDnsForTests(null); await prisma.$disconnect(); });

async function pendingOrder(qty = 1) {
  const org = await makeOrg({ payout: true });
  const { store, sp } = await makeStoreWithProduct(org.id, 2500);
  await prisma.store.update({ where: { id: store.id }, data: { autoFulfill: false } });
  setPaymentProviderForTests(new FakeStripeProvider()); // checkout leaves it PENDING_PAYMENT
  const res: any = await orders.checkout(checkoutInput(store.slug, sp.id, qty) as any);
  setPaymentProviderForTests(null);
  return { org, store, orderId: res.order.id as string };
}

// ---------- #1 fulfilment before email; email never awaited ----------
test('#1 markPaid: fulfilment is started before (and without waiting for) the confirmation email', async () => {
  const { orderId } = await pendingOrder();
  mail.delayMs = 3000; // a slow mail provider
  const t0 = Date.now();
  const r = await orders.markPaid(orderId, uid('pi'), 'stripe');
  const took = Date.now() - t0;
  assert.equal(r.transitioned, true);
  assert.ok(took < 1500, `markPaid returned in ${took} ms, not after the email`);
  assert.ok(await prisma.fulfillment.findUnique({ where: { orderId } }), 'fulfilment exists right after markPaid');
  const row = await prisma.emailMessage.findFirstOrThrow({ where: { orderId, kind: 'ORDER_CONFIRMED' } });
  assert.equal(row.status, 'QUEUED', 'outbox row written; delivery still in flight');
  assert.equal(mail.sent.length, 0);
  await emails.idle();
  assert.equal(mail.sent.length, 1);
  assert.equal((await prisma.emailMessage.findUniqueOrThrow({ where: { id: row.id } })).status, 'SENT');
});

test('#1 sweeper: crash after the paid write (no fulfilment, no email) is recovered exactly once', async () => {
  const { orderId } = await pendingOrder();
  // Simulate the process dying right after the PENDING_PAYMENT → PAID write.
  await prisma.order.update({ where: { id: orderId }, data: { status: 'PAID', providerPaymentId: uid('pi'), provider: 'stripe' } });
  assert.deepEqual((await orders.sweepPaid(new Date())).routed.includes(orderId), false, 'grace period: in-flight requests are left alone');
  const sweeps = await Promise.all([1, 2, 3, 4].map(() => orders.sweepPaid(later(5 * 60_000))));
  assert.ok(sweeps.some((s) => s.routed.includes(orderId)));
  assert.equal(await prisma.fulfillment.count({ where: { orderId } }), 1, 'one fulfilment despite 4 concurrent sweeps');
  assert.equal(await prisma.emailMessage.count({ where: { orderId, kind: 'ORDER_CONFIRMED' } }), 1, 'confirmation recreated once');
  await emails.idle();
  assert.equal(mail.sent.filter((m) => m.subject.includes('confirmed')).length, 1);
  const again = await orders.sweepPaid(later(10 * 60_000));
  assert.ok(!again.routed.includes(orderId) && !again.confirmed.includes(orderId), 'nothing left to do');
  assert.notEqual((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status, 'PAID', 'routed (awaiting approval)');
});

test('#1 routing failure in markPaid does not fail the webhook; the sweeper retries', async () => {
  const { orderId } = await pendingOrder();
  const orig = fulfillment.routeOrder.bind(fulfillment);
  let calls = 0;
  (fulfillment as any).routeOrder = async (id: string) => { calls++; if (calls === 1) throw new Error('supplier down'); return orig(id); };
  try {
    const r = await orders.markPaid(orderId, uid('pi'), 'stripe');
    assert.equal(r.transitioned, true);
    assert.equal(await prisma.fulfillment.count({ where: { orderId } }), 0);
    await orders.sweepPaid(later(5 * 60_000));
    assert.equal(await prisma.fulfillment.count({ where: { orderId } }), 1);
  } finally {
    (fulfillment as any).routeOrder = orig;
  }
});

test('#1 outbox: QUEUED email left by a crash is sent by the sweeper; lease prevents double delivery', async () => {
  const { orderId } = await pendingOrder();
  await prisma.order.update({ where: { id: orderId }, data: { status: 'PAID', providerPaymentId: uid('pi') } });
  // Row written, process died before sending.
  const m = await prisma.emailMessage.create({
    data: { kind: 'ORDER_CONFIRMED', dedupeKey: `ORDER_CONFIRMED:${orderId}`, orderId, to: 'buyer@example.com', from: '"Shop" <orders@storeforge.local>', subject: 'Order confirmed', html: '<p>x</p>', text: 'x' },
  });
  assert.deepEqual(await emails.sweepOutbox(new Date()), [], 'too fresh: the sender may still be working');
  mail.delayMs = 200;
  const runs = await Promise.all([emails.sweepOutbox(later(60_000)), emails.sweepOutbox(later(60_000)), emails.send(m.id)]);
  assert.ok(runs.length === 3);
  assert.equal(mail.sent.length, 1, 'exactly one delivery');
  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } });
  assert.equal(row.status, 'SENT');
  assert.equal(row.lockedUntil, null);
  assert.deepEqual(await emails.sweepOutbox(later(10 * 60_000)), []);
});

test('#1 outbox: an expired lease (sender crashed mid-send) is retried with backoff', async () => {
  const { orderId } = await pendingOrder();
  const m = await prisma.emailMessage.create({
    data: { kind: 'ORDER_SHIPPED', dedupeKey: `ORDER_SHIPPED:${orderId}`, orderId, to: 'buyer@example.com', from: 'x <a@b.c>', subject: 'Shipped', html: 'x', text: 'x', attempts: 1, lockedUntil: new Date(Date.now() - 1000) },
  });
  assert.deepEqual(await emails.sweepOutbox(later(10_000)), [], 'backoff: 30 s after attempt 1');
  assert.deepEqual(await emails.sweepOutbox(later(61_000)), [m.id]);
  assert.equal((await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).status, 'SENT');
});

// ---------- #2 refund reconciler ----------
test('#2 reconciler: unknown refund (created on Stripe, response lost) is resolved; never refunded twice', async () => {
  const fake = new FakeStripeProvider();
  setPaymentProviderForTests(fake);
  const org = await makeOrg({ payout: true });
  const { store, sp } = await makeStoreWithProduct(org.id, 2500);
  const res: any = await orders.checkout(checkoutInput(store.slug, sp.id, 2) as any);
  await orders.markPaid(res.order.id, uid('pi'), 'stripe');
  fake.refundFailure = { error: new Error('socket hang up'), created: true };
  const r = await refunds.create(org.id, res.order.id, { amountCents: 1200, requestId: 'rq-unknown-1' });
  assert.equal(r.status, 'unknown');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: res.order.id } })).refundedCents, 1200, 'amount stays reserved');

  assert.deepEqual(await refunds.reconcileStuck(5 * 60_000, new Date()), [], 'too fresh');
  // Stripe settled it meanwhile
  for (const v of fake.stripeRefunds.values()) v.status = 'succeeded';
  const out = await Promise.all([refunds.reconcileStuck(5 * 60_000, later(6 * 60_000)), refunds.reconcileStuck(5 * 60_000, later(6 * 60_000))]);
  assert.equal(out.flat().filter((x) => x.refundId === r.id).length, 1, 'claimed by one reconciler');
  assert.equal(fake.stripeRefunds.size, 1, 'no second Stripe refund');
  assert.equal((await prisma.orderRefund.findUniqueOrThrow({ where: { id: r.id } })).status, 'succeeded');
  await emails.idle();
  assert.equal(await prisma.emailMessage.count({ where: { orderId: res.order.id, kind: 'ORDER_REFUNDED' } }), 1);
});

test('#2 reconciler: refund never reached Stripe → resubmitted with the same key; failed one releases the reservation', async () => {
  const fake = new FakeStripeProvider();
  setPaymentProviderForTests(fake);
  const org = await makeOrg({ payout: true });
  const { store, sp } = await makeStoreWithProduct(org.id, 2500);
  const res: any = await orders.checkout(checkoutInput(store.slug, sp.id, 2) as any);
  await orders.markPaid(res.order.id, uid('pi'), 'stripe');
  fake.refundFailure = { error: new Error('ETIMEDOUT'), created: false };
  const r = await refunds.create(org.id, res.order.id, { amountCents: 1000, requestId: 'rq-unknown-2' });
  assert.equal(r.status, 'unknown');
  fake.refundStatus = 'pending';
  await refunds.reconcileStuck(5 * 60_000, later(6 * 60_000));
  const after1 = await prisma.orderRefund.findUniqueOrThrow({ where: { id: r.id } });
  assert.equal(after1.status, 'pending');
  assert.equal(fake.refunds.filter((x) => x.idempotencyKey === `sf-orderrefund-${r.id}`).length, 2, 'same idempotency key reused');
  assert.equal(fake.stripeRefunds.size, 1);
  // Later Stripe reports it failed → reservation released by the next reconcile
  for (const v of fake.stripeRefunds.values()) v.status = 'failed';
  await refunds.reconcileStuck(5 * 60_000, later(12 * 60_000));
  assert.equal((await prisma.orderRefund.findUniqueOrThrow({ where: { id: r.id } })).status, 'failed');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: res.order.id } })).refundedCents, 0);
});

test('#2 reconciler: still unresolved after 24 h → merchant + platform alerted once', async () => {
  const fake = new FakeStripeProvider();
  setPaymentProviderForTests(fake);
  const org = await makeOrg({ payout: true });
  const { store, sp } = await makeStoreWithProduct(org.id, 2500);
  const res: any = await orders.checkout(checkoutInput(store.slug, sp.id, 1) as any);
  await orders.markPaid(res.order.id, uid('pi'), 'stripe');
  const r = await refunds.create(org.id, res.order.id, { requestId: 'rq-stuck' }); // pending on Stripe forever
  await refunds.reconcileStuck(5 * 60_000, later(25 * 3600_000));
  await refunds.reconcileStuck(5 * 60_000, later(26 * 3600_000));
  const n = await prisma.notification.findMany({ where: { kind: 'order_refund_stuck', orderId: res.order.id } });
  assert.equal(n.length, 2, 'one merchant + one platform alert');
  assert.ok(n.some((x) => x.organizationId === org.id) && n.some((x) => x.organizationId === null));
  assert.equal((await prisma.orderRefund.findUniqueOrThrow({ where: { id: r.id } })).status, 'pending');
});

// ---------- #4 TLS ----------
test('#4 caddy without DOMAIN_TLS_ASK_TOKEN refuses to start; tls-ask fails closed', async () => {
  assert.throws(() => assertTlsConfig({ DOMAIN_TLS_PROVIDER: 'caddy' } as any), /DOMAIN_TLS_ASK_TOKEN/);
  assert.throws(() => assertTlsConfig({ DOMAIN_TLS_PROVIDER: 'caddy', DOMAIN_TLS_ASK_TOKEN: 'short' } as any), /24/);
  assert.doesNotThrow(() => assertTlsConfig({ DOMAIN_TLS_PROVIDER: 'caddy', DOMAIN_TLS_ASK_TOKEN: 'x'.repeat(32) } as any));
  assert.throws(() => assertTlsConfig({ DOMAIN_TLS_PROVIDER: 'vercel' } as any), /DOMAIN_PROVIDER_TOKEN/);
  assert.doesNotThrow(() => assertTlsConfig({} as any));
  const ctrl = new DomainsController(new DomainsService(), { requireAccountId: async (x: string) => x } as any);
  const prev = { p: process.env.DOMAIN_TLS_PROVIDER, t: process.env.DOMAIN_TLS_ASK_TOKEN };
  process.env.DOMAIN_TLS_PROVIDER = 'caddy';
  delete process.env.DOMAIN_TLS_ASK_TOKEN;
  try {
    await assert.rejects(() => ctrl.tlsAsk('shop.example.com'), /not configured/);
  } finally {
    process.env.DOMAIN_TLS_PROVIDER = prev.p;
    if (prev.t !== undefined) process.env.DOMAIN_TLS_ASK_TOKEN = prev.t;
  }
});

test('#4 probe: private / loopback / metadata addresses are never contacted', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'nope']) {
    assert.ok(isBlockedAddress(ip), ip);
  }
  for (const ip of ['203.0.113.10', '8.8.8.8', '2606:4700::1111']) assert.ok(!isBlockedAddress(ip), ip);
  let called = 0;
  const spy: any = () => { called++; throw new Error('must not connect'); };
  const r = await probeHttps('shop.example.com', '169.254.169.254', 1000, spy);
  assert.equal(r.state, 'failed');
  assert.match(r.detail!, /private or reserved/);
  assert.equal((await probeHttps('shop.example.com', null, 1000, spy)).state, 'pending');
  assert.equal(called, 0);
});

test('#4 probe is pinned: connects to the verified IP with SNI/Host = domain, validates the cert, no DNS', async () => {
  let opts: any = null;
  const fakeReq: any = (o: any, cb: (res: any) => void) => {
    opts = o;
    const req = new EventEmitter() as any;
    req.end = () => setImmediate(() => cb({ resume() {} }));
    req.destroy = () => {};
    return req;
  };
  const r = await probeHttps('shop.example.com', '203.0.113.10', 1000, fakeReq);
  assert.equal(r.state, 'issued');
  assert.equal(opts.host, '203.0.113.10');
  assert.equal(opts.servername, 'shop.example.com');
  assert.equal(opts.headers.Host, 'shop.example.com');
  assert.equal(opts.rejectUnauthorized, true);
  assert.throws(() => opts.lookup('evil.example', {}, () => {}), /disabled/);
});

test('#4 domain check records the verified edge IP and passes it to the TLS provider', async () => {
  const seen: (string | null | undefined)[] = [];
  class SpyTls implements TlsProvider {
    readonly kind = 'caddy' as const;
    async request(_h: string, ctx?: { ip: string | null }): Promise<TlsState> { seen.push(ctx?.ip); return { state: 'pending' }; }
    async status(_h: string, ctx: any): Promise<TlsState> { seen.push(ctx.ip); return { state: 'issued' }; }
    async remove() {}
  }
  const snaps = new Map<string, DnsSnapshot>();
  const fakeDns: DnsLookup = { mode: 'live', async lookup(h: string) { return snaps.get(h) ?? { txt: [], cname: [], a: [] }; }, async resolveA() { return ['203.0.113.10']; } } as any;
  setDnsForTests(fakeDns);
  setTlsForTests(new SpyTls());
  process.env.DOMAIN_CNAME_TARGET = 'stores.storeforge.local';
  const svc = new DomainsService();
  const org = await makeOrg();
  const store = await prisma.store.create({ data: { organizationId: org.id, name: 'S', slug: uid('s').toLowerCase().replace(/_/g, '-') } });
  const host = `${uid('shop').toLowerCase().replace(/_/g, '')}.example.com`;
  const d = await svc.add(org.id, store.id, host);
  const row = await prisma.domain.findUniqueOrThrow({ where: { id: (d as any).id } });
  // CNAME to our target, resolver also returns the flattened A (ours) plus an attacker-controlled extra
  snaps.set(host, { txt: [txtValue(row.verificationToken)], cname: ['stores.storeforge.local'], a: ['198.51.100.66', '203.0.113.10'] });
  const c1 = await svc.check(row.id);
  assert.equal(c1.verifiedIp, '203.0.113.10', 'only one of OUR edge IPs is ever pinned');
  await svc.check(row.id); // ISSUING_TLS → status() with the stored ip
  assert.deepEqual(seen, ['203.0.113.10', '203.0.113.10']);
  setDnsForTests(null);
  setTlsForTests(null);
});

// ---------- #5 header CR/LF ----------
test('#5 subjects: CR/LF and control characters stripped (stored and at send time)', async () => {
  assert.equal(headerLine('Order confirmed\r\nBcc: victim@example.com'), 'Order confirmed Bcc: victim@example.com');
  assert.equal(headerLine('a\u0000b\tc   d'), 'abc d');
  const { orderId } = await pendingOrder();
  await prisma.store.update({ where: { id: (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).storeId }, data: { name: 'Evil\r\nBcc: x@y.z' } });
  await orders.markPaid(orderId, uid('pi'), 'stripe');
  await emails.idle();
  const row = await prisma.emailMessage.findFirstOrThrow({ where: { orderId } });
  assert.ok(!/[\r\n]/.test(row.subject) && !/[\r\n]/.test(row.from));
  // A legacy row with a bad subject is still sanitised on the way out
  const bad = await prisma.emailMessage.create({ data: { kind: 'ORDER_DELIVERED', dedupeKey: uid('dk'), orderId, to: 'b@example.com\r\n', from: 'x <a@b.c>', subject: 'Hi\r\nBcc: z@z.z', html: 'x', text: 'x' } });
  await emails.send(bad.id);
  const out = mail.sent.at(-1)!;
  assert.equal(out.subject, 'Hi Bcc: z@z.z');
  assert.equal(out.to, 'b@example.com');
});

// ---------- #6 CHECK constraint ----------
test('#6 DB CHECK: 0 <= refundedCents <= totalCents', async () => {
  const { orderId } = await pendingOrder();
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  await assert.rejects(() => prisma.order.update({ where: { id: orderId }, data: { refundedCents: o.totalCents + 1 } }), /Order_refunded_within_paid|check constraint/i);
  await assert.rejects(() => prisma.order.update({ where: { id: orderId }, data: { refundedCents: -1 } }), /Order_refunded_within_paid|check constraint/i);
  await prisma.order.update({ where: { id: orderId }, data: { refundedCents: o.totalCents } });
});
