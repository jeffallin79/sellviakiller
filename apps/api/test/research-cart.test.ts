// Phase 1 slice 5: abandoned-cart recovery (consent, unsubscribe, idempotent reminders through the
// email outbox) and research tools (ProductScore, margin calculator, stub/live sources, LLM drafts).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@storeforge/db';
import { CART_CONSENT_TEXT, marginCalc, compositeScore, searchSignal, saturationScore, etaScore, marginScore, trendScore, researchKeyword } from '@storeforge/shared';
import { setPaymentProviderForTests } from '../src/payments';
import { SuppliersService } from '../src/suppliers/suppliers.service';
import { FulfillmentService } from '../src/fulfillment/fulfillment.service';
import { OrdersService } from '../src/orders/orders.service';
import { EmailService } from '../src/email/email.service';
import { setEmailTransportForTests, type EmailTransport, type OutgoingEmail } from '../src/email/transport';
import { emailHash, recoverSig, unsubscribeSig, maskEmail } from '../src/email/links';
import { CartsService } from '../src/carts/carts.service';
import { CartsController } from '../src/carts/carts.controller';
import { ResearchService } from '../src/research/research.service';
import { StubTrends, StubAdLibrary, SerpApiTrends, MetaAdLibrary, setResearchSourcesForTests } from '../src/research/sources';
import { OpenAiCompatibleLlm, setLlmForTests } from '../src/research/llm';
import { FakeStripeProvider, makeOrg, makeStoreWithProduct, checkoutInput, uid } from './helpers';

class MemoryTransport implements EmailTransport {
  readonly kind = 'outbox' as const;
  sent: OutgoingEmail[] = [];
  async send(m: OutgoingEmail) { this.sent.push(m); return { providerMessageId: `mem_${this.sent.length}` }; }
}
const emails = new EmailService();
const orders = new OrdersService(new FulfillmentService(new SuppliersService(), emails), emails);
const carts = new CartsService(emails);
const ctrl = new CartsController(carts, { requireAccountId: async (id: string) => id } as any);
const research = new ResearchService();
let mail: MemoryTransport;
const H = 3_600_000;

beforeEach(() => { mail = new MemoryTransport(); setEmailTransportForTests(mail); setPaymentProviderForTests(null); setResearchSourcesForTests(null, null); setLlmForTests(null); });
after(async () => { await emails.idle(); setEmailTransportForTests(null); setPaymentProviderForTests(null); setResearchSourcesForTests(null, null); setLlmForTests(null); await prisma.$disconnect(); });

const token = () => uid('tok').replace(/[^A-Za-z0-9_-]/g, '').padEnd(20, 'x');
async function shop(o: { address?: string | null; recovery?: boolean } = {}) {
  const org = await makeOrg();
  const user = await prisma.user.create({ data: { email: `${uid('owner')}@example.com`, name: 'Owner' } });
  await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: 'owner' } });
  const { store, sp, product } = await makeStoreWithProduct(org.id, 2500);
  await prisma.product.update({ where: { id: product.id }, data: { etaDaysMin: 6, etaDaysMax: 12 } });
  await prisma.store.update({ where: { id: store.id }, data: { name: 'Juniper Test', mailingAddress: o.address === undefined ? '12 Rose Lane, Regina SK S4P 1A1, Canada' : o.address, cartRecovery: o.recovery ?? true } });
  return { org, store: { ...store, name: 'Juniper Test' }, sp, product, owner: user };
}
async function captured(s: Awaited<ReturnType<typeof shop>>, email = `${uid('ada')}@example.com`, qty = 2) {
  const tk = token();
  const r = await carts.capture({ storeSlug: s.store.slug, token: tk, email, name: 'Ada Lovelace', consent: true, lines: [{ storeProductId: s.sp.id, quantity: qty }] }, uid('ip'));
  assert.equal(r.stored, true);
  return { token: tk, email, cart: await prisma.cart.findUniqueOrThrow({ where: { id: r.id! } }) };
}
const later = (c: { lastActivityAt: Date }, ms: number) => new Date(c.lastActivityAt.getTime() + ms);
const cartMails = (cartId: string) => prisma.emailMessage.findMany({ where: { cartId }, orderBy: { createdAt: 'asc' } });

// ---------------------------------------------------------------- consent
test('cart capture: nothing stored without consent; consent stores the exact wording; unticking scrubs the email', async () => {
  const s = await shop();
  const tk = token();
  const no = await carts.capture({ storeSlug: s.store.slug, token: tk, email: 'nope@example.com', consent: false, lines: [{ storeProductId: s.sp.id, quantity: 1 }] }, uid('ip'));
  assert.deepEqual(no, { stored: false, withdrawn: false });
  assert.equal(await prisma.cart.count({ where: { storeId: s.store.id } }), 0, 'no row, no email kept');
  const yes = await carts.capture({ storeSlug: s.store.slug, token: tk, email: '  Ada@Example.COM ', name: 'Ada', consent: true, lines: [{ storeProductId: s.sp.id, quantity: 3 }, { storeProductId: 'not-mine', quantity: 1 }] } as any, uid('ip'));
  const c = await prisma.cart.findUniqueOrThrow({ where: { id: yes.id! } });
  assert.equal(c.email, 'ada@example.com');
  assert.equal(c.emailHash, emailHash('ada@example.com'));
  assert.equal(c.consentText, CART_CONSENT_TEXT);
  assert.ok(c.consentAt);
  assert.equal(c.itemCount, 3, 'unknown products dropped');
  assert.equal(c.subtotalCents, 7500, 'priced server-side');
  const w = await carts.capture({ storeSlug: s.store.slug, token: tk, consent: false, lines: [] }, uid('ip'));
  assert.equal(w.withdrawn, true);
  const c2 = await prisma.cart.findUniqueOrThrow({ where: { id: c.id } });
  assert.deepEqual([c2.consent, c2.email, c2.customerName, c2.consentAt], [false, null, null, null]);
  const r = await carts.sweep(later(c2, 2 * H));
  assert.ok(!r.reminders.some((x) => x.cartId === c.id), 'withdrawn consent → no reminder');
});

// ---------------------------------------------------------------- timing + idempotency
test('reminders: 1 h then 24 h after last activity, at most two, through the email outbox; concurrent sweeps send once', async () => {
  const s = await shop();
  const { cart, email } = await captured(s);
  assert.equal((await carts.sweep(later(cart, 59 * 60_000))).reminders.filter((x) => x.cartId === cart.id).length, 0, 'not before 1 h');
  // five sweepers at once (several API instances) → one reminder
  const now1 = later(cart, 61 * 60_000);
  await Promise.all([1, 2, 3, 4, 5].map(() => carts.sweep(now1)));
  await Promise.all([carts.remind(cart.id, 1, now1), carts.remind(cart.id, 1, now1)]);
  await emails.idle();
  let ms = await cartMails(cart.id);
  assert.equal(ms.length, 1);
  assert.deepEqual([ms[0].kind, ms[0].status, ms[0].to, ms[0].dedupeKey], ['CART_REMINDER_1', 'SENT', email, `CART_REMINDER_1:${cart.id}`]);
  assert.equal(mail.sent.filter((m) => m.to === email).length, 1, 'delivered once');
  // reminder 2 not at 12 h, yes at 24 h
  assert.equal((await carts.sweep(later(cart, 12 * H))).reminders.filter((x) => x.cartId === cart.id).length, 0);
  const now2 = later(cart, 24 * H + 60_000);
  await Promise.all([carts.sweep(now2), carts.sweep(now2), carts.remind(cart.id, 2, now2)]);
  await emails.idle();
  ms = await cartMails(cart.id);
  assert.deepEqual(ms.map((m) => m.kind), ['CART_REMINDER_1', 'CART_REMINDER_2']);
  // never a third
  await carts.sweep(later(cart, 60 * H));
  assert.equal((await cartMails(cart.id)).length, 2);
  assert.equal(mail.sent.filter((m) => m.to === email).length, 2);
});

test('reminders: shopper activity restarts the 1 h clock; carts idle > 72 h get no first reminder; > 7 days expire and scrub', async () => {
  const s = await shop();
  const { cart, token: tk, email } = await captured(s);
  await carts.capture({ storeSlug: s.store.slug, token: tk, email, consent: true, lines: [{ storeProductId: s.sp.id, quantity: 4 }] }, uid('ip'));
  const c = await prisma.cart.findUniqueOrThrow({ where: { id: cart.id } });
  assert.ok(c.lastActivityAt > cart.lastActivityAt);
  assert.equal(c.subtotalCents, 10_000);
  const stale = await captured(s);
  await prisma.cart.update({ where: { id: stale.cart.id }, data: { lastActivityAt: new Date(Date.now() - 80 * H) } });
  const r = await carts.sweep(new Date());
  assert.ok(!r.reminders.some((x) => x.cartId === stale.cart.id), 'stale cart not reminded');
  await prisma.cart.update({ where: { id: stale.cart.id }, data: { lastActivityAt: new Date(Date.now() - 8 * 24 * H) } });
  await carts.sweep(new Date());
  const e = await prisma.cart.findUniqueOrThrow({ where: { id: stale.cart.id } });
  assert.deepEqual([e.status, e.email, e.customerName], ['EXPIRED', null, null]);
  assert.ok(e.emailHash, 'hash kept for caps/suppression');
});

// ---------------------------------------------------------------- conversion
test('conversion: paid checkout closes the cart (no reminders), cancels a queued reminder; revenue counts as recovered only after a sent reminder', async () => {
  const s = await shop();
  const { cart, token: tk, email } = await captured(s);
  // reminder 1 goes out, the shopper comes back via the link and pays (stub checkout = paid)
  await carts.sweep(later(cart, 61 * 60_000));
  await emails.idle();
  const rec = await carts.recover(cart.id, recoverSig(cart.id));
  assert.equal(rec.token, tk);
  assert.deepEqual(rec.lines, [{ storeProductId: s.sp.id, quantity: 2 }]);
  const res: any = await orders.checkout({ ...checkoutInput(s.store.slug, s.sp.id, 2), email, cartToken: tk } as any);
  const c = await prisma.cart.findUniqueOrThrow({ where: { id: cart.id } });
  assert.equal(c.status, 'CONVERTED');
  assert.equal(c.orderId, res.order.id);
  assert.equal(c.recoveredCents, res.order.totalCents, 'paid after a delivered reminder → recovered');
  assert.equal(c.email, null, 'email scrubbed once converted');
  assert.ok(c.recoveredAt);
  await carts.sweep(later(cart, 30 * H));
  assert.equal((await cartMails(cart.id)).length, 1, 'no reminder 2 after buying');

  // a reminder queued but not yet delivered when the order is paid → CANCELLED, never sent
  const b = await captured(s);
  await prisma.cart.update({ where: { id: b.cart.id }, data: { reminder1At: new Date() } });
  const queued = await prisma.emailMessage.create({ data: { kind: 'CART_REMINDER_1', dedupeKey: `CART_REMINDER_1:${b.cart.id}`, storeId: s.store.id, cartId: b.cart.id, to: b.email, from: 'x <x@y.z>', subject: 's', html: 'h', text: 't' } });
  await orders.checkout({ ...checkoutInput(s.store.slug, s.sp.id, 1), email: b.email.toUpperCase() } as any); // same address, different tab, no token
  assert.equal((await prisma.cart.findUniqueOrThrow({ where: { id: b.cart.id } })).status, 'CONVERTED', 'matched by address');
  assert.equal((await prisma.cart.findUniqueOrThrow({ where: { id: b.cart.id } })).recoveredCents, null, 'no reminder delivered → not counted as recovered');
  await emails.send(queued.id);
  const q = await prisma.emailMessage.findUniqueOrThrow({ where: { id: queued.id } });
  assert.equal(q.status, 'CANCELLED');
  assert.ok(!mail.sent.some((m) => m.to === b.email), 'never delivered');
});

test('conversion: abandoned on Stripe Checkout (order pending) still gets reminders; ticking at the last step creates the cart', async () => {
  const fake = new FakeStripeProvider();
  setPaymentProviderForTests(fake);
  const s = await shop();
  await prisma.organization.update({ where: { id: s.org.id }, data: { payoutAccountId: uid('acct'), payoutProvider: 'stripe', payoutChargesEnabled: true } });
  const tk = token();
  const email = `${uid('late')}@example.com`;
  const res: any = await orders.checkout({ ...checkoutInput(s.store.slug, s.sp.id, 1), email, cartToken: tk, cartConsent: true } as any);
  assert.equal(res.order.status, 'PENDING_PAYMENT');
  const c = await prisma.cart.findUniqueOrThrow({ where: { storeId_token: { storeId: s.store.id, token: tk } } });
  assert.deepEqual([c.status, c.consent, c.email, c.orderId, c.consentText], ['OPEN', true, email, res.order.id, CART_CONSENT_TEXT]);
  const r = await carts.sweep(later(c, 61 * 60_000));
  assert.equal(r.reminders.find((x) => x.cartId === c.id)?.result, 'queued');
  // without the tick, a last-step checkout keeps nothing
  const tk2 = token();
  await orders.checkout({ ...checkoutInput(s.store.slug, s.sp.id, 1), email: `${uid('x')}@example.com`, cartToken: tk2 } as any);
  assert.equal(await prisma.cart.count({ where: { storeId: s.store.id, token: tk2 } }), 0);
  // the webhook pays the first order → cart closed
  await orders.markPaid(res.order.id, uid('pi'), 'stripe');
  assert.equal((await prisma.cart.findUniqueOrThrow({ where: { id: c.id } })).status, 'CONVERTED');
});

// ---------------------------------------------------------------- unsubscribe
test('unsubscribe: GET only shows a button; POST and RFC 8058 one-click unsubscribe; bad signatures rejected; queued reminders cancelled; address never stored again', async () => {
  const s = await shop();
  const { cart, email, token: tk } = await captured(s);
  const h = emailHash(email);
  const sig = unsubscribeSig(s.store.id, h);
  const page = await ctrl.unsubscribePage(s.store.id, h, sig);
  assert.match(page, /Stop bag reminders from Juniper Test\?/);
  assert.match(page, /<form method="post"/);
  assert.equal(await prisma.emailSuppression.count({ where: { storeId: s.store.id, emailHash: h } }), 0, 'GET (link scanners) does not unsubscribe');
  assert.match(await ctrl.unsubscribePage(s.store.id, h, 'forged-signature-forged-signatur'), /isn't valid/);
  await assert.rejects(carts.unsubscribe(s.store.id, h, 'x'.repeat(32)));
  await assert.rejects(carts.unsubscribe(s.store.id, emailHash('other@example.com'), sig), 'signature is bound to the address');
  // a reminder is queued, then the shopper one-click unsubscribes from their mail app
  await prisma.cart.update({ where: { id: cart.id }, data: { reminder1At: new Date() } });
  const queued = await prisma.emailMessage.create({ data: { kind: 'CART_REMINDER_1', dedupeKey: `CART_REMINDER_1:${cart.id}`, storeId: s.store.id, cartId: cart.id, to: email, from: 'x <x@y.z>', subject: 's', html: 'h', text: 't' } });
  const res: any = { statusCode: 0, body: '', status(c: number) { this.statusCode = c; return this; }, type() { return this; }, send(b: string) { this.body = b; return this; }, setHeader() {} };
  await ctrl.unsubscribe(s.store.id, h, sig, { 'List-Unsubscribe': 'One-Click' }, res);
  assert.deepEqual([res.statusCode, res.body], [200, 'unsubscribed']);
  await ctrl.unsubscribe(s.store.id, h, sig, {}, res); // the button too; idempotent
  assert.equal(res.statusCode, 200);
  assert.equal(await prisma.emailSuppression.count({ where: { storeId: s.store.id, emailHash: h } }), 1);
  const c = await prisma.cart.findUniqueOrThrow({ where: { id: cart.id } });
  assert.deepEqual([c.status, c.email, c.consent], ['OPTED_OUT', null, false]);
  assert.equal((await prisma.emailMessage.findUniqueOrThrow({ where: { id: queued.id } })).status, 'CANCELLED');
  await emails.send(queued.id);
  assert.ok(!mail.sent.some((m) => m.to === email));
  assert.match(await ctrl.unsubscribePage(s.store.id, h, sig), /You're unsubscribed/);
  // re-capturing the same address at this shop stores nothing; the old token can't be reused
  const again = await carts.capture({ storeSlug: s.store.slug, token: token(), email: email.toUpperCase(), consent: true, lines: [{ storeProductId: s.sp.id, quantity: 1 }] }, uid('ip'));
  assert.deepEqual(again, { stored: false, reason: 'unsubscribed' });
  assert.deepEqual(await carts.capture({ storeSlug: s.store.slug, token: tk, email, consent: true, lines: [] }, uid('ip')), { stored: false, rotate: true });
  // suppression is per shop: another shop can still ask
  const s2 = await shop();
  assert.equal((await carts.capture({ storeSlug: s2.store.slug, token: token(), email, consent: true, lines: [{ storeProductId: s2.sp.id, quantity: 1 }] }, uid('ip'))).stored, true);
  // order emails (transactional) are not affected by the marketing unsubscribe
  const o: any = await orders.checkout({ ...checkoutInput(s.store.slug, s.sp.id, 1), email } as any);
  await emails.idle();
  assert.equal((await prisma.emailMessage.findFirstOrThrow({ where: { orderId: o.order.id, kind: 'ORDER_CONFIRMED' } })).status, 'SENT');
});

// ---------------------------------------------------------------- content + legal
test('reminder email: honest copy, one-click unsubscribe headers, postal address, signed links; no address or recovery off → nothing sent', async () => {
  const s = await shop();
  const { cart, email } = await captured(s);
  await carts.sweep(later(cart, 61 * 60_000));
  await emails.idle();
  const out = mail.sent.find((m) => m.to === email)!;
  assert.ok(out, 'sent');
  assert.match(out.subject, /You left 2 items in your Juniper Test bag/);
  assert.match(out.from, /^"Juniper Test" </);
  assert.equal(out.replyTo, s.owner.email, 'replies go to the shop owner');
  const h = emailHash(email);
  const unsub = `/api/email/unsubscribe?s=${s.store.id}&e=${h}&t=${unsubscribeSig(s.store.id, h)}`;
  assert.ok(out.headers?.['List-Unsubscribe']?.includes(unsub), out.headers?.['List-Unsubscribe']);
  assert.equal(out.headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  for (const body of [out.html, out.text]) {
    assert.ok(body.includes('12 Rose Lane, Regina SK S4P 1A1, Canada'), 'postal address (CAN-SPAM / CASL)');
    assert.ok(body.includes(unsub.replace(/&/g, body === out.html ? '&amp;' : '&')), 'unsubscribe link');
    assert.ok(body.includes(`recover=${cart.id}`) && body.includes(recoverSig(cart.id)), 'signed recovery link');
    assert.match(body, /ticked "email me a reminder"|ticked &quot;email me a reminder&quot;/);
    assert.doesNotMatch(body, /% off|discount|hurry|only \d+ left|expires in|countdown|last chance/i, 'no bait or fake urgency');
    assert.match(body, /6–12 days/);
  }
  assert.ok(!out.html.includes('<script'), 'no script');
  // recovery link with a bad signature
  await assert.rejects(carts.recover(cart.id, 'bad'), /not valid/);

  const noAddr = await shop({ address: null });
  const a = await captured(noAddr);
  const off = await shop({ recovery: false });
  const b = await captured(off);
  const r = await carts.sweep(later(a.cart, 2 * H));
  assert.ok(!r.reminders.some((x) => x.cartId === a.cart.id || x.cartId === b.cart.id));
  assert.equal(await prisma.emailMessage.count({ where: { cartId: { in: [a.cart.id, b.cart.id] } } }), 0);
  await assert.rejects(carts.updateSettings(noAddr.org.id, noAddr.store.id, { enabled: true, mailingAddress: '' }), /mailing address is required/);
  await assert.rejects(carts.updateSettings(noAddr.org.id, noAddr.store.id, { enabled: true }), /mailing address is required/);
  const ov = await carts.updateSettings(noAddr.org.id, noAddr.store.id, { enabled: true, mailingAddress: '1 Main St\r\nRegina SK' });
  assert.equal(ov.settings.mailingAddress, '1 Main St, Regina SK', 'single line, no header/CRLF tricks');
  assert.equal(ov.settings.ready, true);
});

test('per-address cap: one reminder sequence per address per shop per week, however many carts', async () => {
  const s = await shop();
  const email = `${uid('multi')}@example.com`;
  const a = await captured(s, email);
  const b = await captured(s, email);
  const now = new Date(Math.max(a.cart.lastActivityAt.getTime(), b.cart.lastActivityAt.getTime()) + 61 * 60_000);
  await carts.remind(a.cart.id, 1, now);
  const rb = await carts.remind(b.cart.id, 1, now);
  assert.equal(rb, 'capped');
  await carts.sweep(new Date(now.getTime() + 25 * H));
  await emails.idle();
  assert.equal(await prisma.emailMessage.count({ where: { cartId: b.cart.id } }), 0, 'second cart never emails');
  assert.ok(mail.sent.filter((m) => m.to === email).length <= 2);
});

test('merchant overview: masked emails, recovered revenue, org-scoped', async () => {
  const s = await shop();
  await captured(s, 'jane.doe@example.com');
  const ov = await carts.overview(s.org.id, s.store.id);
  assert.equal(ov.carts[0].email, 'j•••e@example.com');
  assert.equal(maskEmail('ab@x.io'), 'a@x.io');
  assert.equal(ov.settings.ready, true);
  assert.equal(ov.consentText, CART_CONSENT_TEXT);
  assert.ok(!JSON.stringify(ov).includes('jane.doe@'), 'full address never in the merchant list');
  const other = await makeOrg();
  await assert.rejects(carts.overview(other.id, s.store.id), /not found/i);
});

// ---------------------------------------------------------------- research
test('margin calculator: unit economics with ad cost and fee (hand-checked)', () => {
  const r = marginCalc({ priceCents: 4000, costCents: 1500, supplierShippingCents: 350, shippingChargedCents: 499, adCostPerOrderCents: 1200, adFeePct: 15, refundRatePct: 3 });
  // revenue 4499; payment 2.9% = 130 + 30 = 160; refunds 3% = 135; cogs 1850; before ads 4499−1850−160−135 = 2354
  assert.equal(r.revenueCents, 4499);
  assert.equal(r.paymentFeesCents, 160);
  assert.equal(r.refundReserveCents, 135);
  assert.equal(r.profitBeforeAdsCents, 2354);
  assert.equal(r.adFeeCents, 180);
  assert.equal(r.profitCents, 2354 - 1200 - 180);
  assert.equal(r.marginPct, Math.round(((2354 - 1380) / 4499) * 1000) / 10);
  assert.equal(r.breakEvenCpaCents, Math.floor(2354 / 1.15));
  assert.equal(r.breakEvenRoas, Math.round((4499 / Math.floor(2354 / 1.15)) * 100) / 100);
  assert.equal(r.platformFeeCents, 0, 'PLATFORM_FEE_BPS default 0');
  const owned = marginCalc({ priceCents: 4000, costCents: 1500, adCostPerOrderCents: 1200, adFeePct: 0 });
  assert.equal(owned.adFeeCents, 0, 'connect-your-own: ADS_OWNED_FEE_PCT 0');
  const loss = marginCalc({ priceCents: 1000, costCents: 980, adCostPerOrderCents: 500 }); // loses money before ads
  assert.ok(loss.profitCents < 0 && loss.breakEvenRoas === null);
  assert.equal(marginCalc({ priceCents: 0, costCents: 0 }).marginPct, 0);
});

test('score parts: trend, margin, saturation, shipping and the weighted composite', () => {
  const rising = searchSignal([...Array(40).fill(30), ...Array(12).fill(70)]);
  const falling = searchSignal([...Array(40).fill(70), ...Array(12).fill(30)]);
  assert.ok(rising.score > falling.score && rising.change! > 0 && falling.change! < 0);
  assert.ok(trendScore(50, 5) > trendScore(50, 0), 'order velocity helps');
  assert.equal(marginScore(-5), 0); assert.equal(marginScore(35), 100);
  assert.equal(saturationScore(0), 0); assert.ok(saturationScore(300) >= 90); assert.equal(saturationScore(null), 50);
  assert.equal(etaScore(7), 100); assert.equal(etaScore(30), 0);
  assert.equal(compositeScore({ trend: 100, margin: 100, saturation: 0, eta: 100 }), 100);
  assert.equal(compositeScore({ trend: 0, margin: 0, saturation: 100, eta: 0 }), 0);
  assert.equal(researchKeyword('Premium Bamboo Cutting Board Set 3pcs'), 'bamboo cutting board', 'filler and pack sizes dropped');
});

test('ProductScore (stub sources): deterministic, sample-labelled, uses StoreForge order velocity, idempotent upsert', async () => {
  const s = await shop();
  await prisma.product.update({ where: { id: s.product.id }, data: { title: 'Glow Desk Lamp', category: 'Home & Garden' } });
  const a = await research.score(s.product.id, { force: true });
  const b = await research.score(s.product.id); // fresh → cached row
  assert.equal(b.id, a.id);
  assert.equal(await prisma.productScore.count({ where: { productId: s.product.id } }), 1);
  assert.deepEqual((a.sources as any).trends, 'stub');
  assert.deepEqual((a.sources as any).adLibrary, 'stub');
  assert.match(a.insight, /^Sample data\./, 'stub data is labelled');
  assert.equal(a.keyword, 'glow desk lamp');
  const series = (a.inputs as any).series as number[];
  assert.equal(series.length, 52);
  assert.deepEqual(series, await new StubTrends().weekly('glow desk lamp', 'US'), 'deterministic');
  assert.equal(a.adCount, await new StubAdLibrary().activeAds('glow desk lamp'));
  assert.equal(a.score, compositeScore({ trend: a.trendScore, margin: a.marginScore, saturation: a.saturationScore, eta: a.etaScore }));
  const asm = (a.inputs as any).assumptions;
  assert.deepEqual([asm.adFeePct, asm.platformFeeBps, asm.adCostPerOrderCents], [15, 0, Math.round(s.product.priceCents * 0.3)]);
  assert.equal(a.profitCents, marginCalc(asm).profitCents, 'stored profit = the shared calculator');
  assert.equal(((a.angles as any[]) ?? []).length, 3);
  // paid orders raise velocity
  assert.equal(a.orderVelocity, 0);
  for (let i = 0; i < 3; i++) await orders.checkout({ ...checkoutInput(s.store.slug, s.sp.id, 2), email: `${uid('v')}@example.com` } as any);
  const c = await research.score(s.product.id, { force: true });
  assert.equal(c.orderVelocity, Math.round((6 / 14) * 100) / 100);
  assert.ok(c.trendScore >= a.trendScore);
  const list = await research.list({ sort: 'score', take: 5 });
  assert.ok(list.items.length >= 1 && list.items[0].series.length > 0);
  assert.equal(list.sources.trends, 'stub');
});

test('live adapters (fake network): SerpApi Trends parsed; Meta Ad Library counts EU/UK active ads with a page cap; errors fall back without breaking the score', async () => {
  const calls: string[] = [];
  const serp = new SerpApiTrends('serp_test_key', (async (u: any) => {
    calls.push(String(u));
    return new Response(JSON.stringify({ interest_over_time: { timeline_data: [10, 20, 30, 40].map((v) => ({ values: [{ extracted_value: v }] })) } }), { status: 200 });
  }) as any);
  assert.deepEqual(await serp.weekly('glow desk lamp', 'US'), [10, 20, 30, 40]);
  const u = new URL(calls[0]);
  assert.deepEqual([u.host, u.searchParams.get('engine'), u.searchParams.get('data_type'), u.searchParams.get('geo')], ['serpapi.com', 'google_trends', 'TIMESERIES', 'US']);
  let pages = 0;
  const meta = new MetaAdLibrary('meta_lib_token', 'v26.0', (async (url: string) => {
    pages++;
    const q = new URL(url);
    if (pages === 1) {
      assert.equal(q.pathname, '/v26.0/ads_archive');
      assert.ok(JSON.parse(q.searchParams.get('ad_reached_countries')!).includes('DE'));
      assert.equal(q.searchParams.get('ad_active_status'), 'ACTIVE');
    }
    return new Response(JSON.stringify({ data: Array(250).fill({ id: '1' }), paging: { next: 'https://graph.facebook.com/v26.0/ads_archive?after=x' } }), { status: 200 });
  }) as any);
  assert.equal(await meta.activeAds('glow desk lamp'), 1000, 'capped at 4 pages');
  assert.equal(pages, 4);
  const evil = new MetaAdLibrary('t', 'v26.0', (async () => new Response(JSON.stringify({ data: [{ id: 1 }], paging: { next: 'https://evil.example/steal' } }), { status: 200 })) as any);
  assert.equal(await evil.activeAds('x'), 1, 'never follows a paging link off graph.facebook.com');
  // a failing live source → score still computed, error recorded
  setResearchSourcesForTests({ kind: 'serpapi', weekly: async () => { throw new Error('serpapi 429: rate limited'); } } as any, new StubAdLibrary());
  const s = await shop();
  const sc = await research.score(s.product.id, { force: true });
  assert.match((sc.sources as any).errors.trends, /429/);
  assert.equal(sc.searchIndex, null);
});

test('LLM drafts: live output is sanitised and policy-scanned (blocked angles dropped); failures fall back to templates; stub makes no network call', async () => {
  const s = await shop();
  let body: any = null;
  setLlmForTests(new OpenAiCompatibleLlm('sk-test', 'gpt-6-luna', 'https://llm.test/v1', (async (url: string, init: any) => {
    assert.equal(url, 'https://llm.test/v1/chat/completions');
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      insight: '<b>Solid</b> margin, busy ad space.\nWeakest: shipping time.',
      angles: [
        { headline: 'Light that fits your desk', primaryText: 'A warm, simple lamp. Arrives in 6–12 days.' },
        { headline: 'Cure your insomnia', primaryText: 'Guaranteed to cure insomnia or your money back' },
        { headline: 'A'.repeat(80), primaryText: 'B'.repeat(300) },
      ],
    }) } }] }), { status: 200 });
  }) as any));
  const sc = await research.score(s.product.id, { force: true });
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.response_format.type, 'json_object');
  assert.match(body.messages[0].content, /no fake urgency/);
  assert.equal(sc.insight, 'Sample data. Solid margin, busy ad space. Weakest: shipping time.', 'tags/newlines stripped, sample label kept');
  const angles = sc.angles as any[];
  assert.ok(!angles.some((a) => /cure/i.test(a.headline + a.primaryText)), 'health claim (policy block) dropped');
  assert.ok(angles.every((a) => a.headline.length <= 40 && a.primaryText.length <= 125));
  assert.equal((sc.sources as any).llm, 'openai');
  setLlmForTests(new OpenAiCompatibleLlm('sk-test', 'gpt-6-luna', 'https://llm.test/v1', (async () => new Response('{"error":{"message":"quota"}}', { status: 429 })) as any));
  const fb = await research.score(s.product.id, { force: true });
  assert.match((fb.sources as any).errors.llm, /429/);
  assert.match(fb.insight, /^Sample data\. Search interest for/);
  assert.equal((fb.angles as any[]).length, 3);
  setLlmForTests(null);
  const orig = globalThis.fetch;
  let net = 0;
  globalThis.fetch = (async () => { net++; throw new Error('no network in stub mode'); }) as any;
  try { await research.score(s.product.id, { force: true }); } finally { globalThis.fetch = orig; }
  assert.equal(net, 0, 'stub mode: no external calls at all');
});
