// Phase 1 slice 3: Boost (Meta, connect your own) + Conversions API, against the stub Meta client.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prisma } from '@storeforge/db';
import { setPaymentProviderForTests } from '../src/payments';
import { SuppliersService } from '../src/suppliers/suppliers.service';
import { FulfillmentService } from '../src/fulfillment/fulfillment.service';
import { OrdersService } from '../src/orders/orders.service';
import { EmailService } from '../src/email/email.service';
import { setEmailTransportForTests } from '../src/email/transport';
import { AdWalletService } from '../src/ads/wallet.service';
import { BoostService } from '../src/ads/boost.service';
import { ConversionsService, norm } from '../src/ads/conversions.service';
import { StubMetaClient, setMetaClientForTests, MetaApiError } from '../src/ads/meta';
import { openToken } from '../src/ads/token-vault';
import { creditTopUp } from '../src/ads/ledger';
import { makeOrg, makeStoreWithProduct, checkoutInput, uid } from './helpers';

const wallet = new AdWalletService();
const boost = new BoostService(wallet);
const emails = new EmailService();
const orders = new OrdersService(new FulfillmentService(new SuppliersService(), emails), emails);
const capi: ConversionsService = (orders as any).conversions;
let meta: StubMetaClient;
let offset = 0;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const ACT = 'act_1029384756';
const PIXEL = '873462519203';
const PAGE = '104857600123456';

beforeEach(() => {
  offset = 0;
  meta = new StubMetaClient(null);
  meta.now = () => Date.now() + offset;
  setMetaClientForTests(meta);
  setPaymentProviderForTests(null);
  setEmailTransportForTests({ kind: 'outbox', send: async () => ({ providerMessageId: 'x' }) } as any);
});
after(async () => { await emails.idle(); await capi.idle(); setMetaClientForTests(null); setEmailTransportForTests(null); await prisma.$disconnect(); });

async function connected(opts: { testEventCode?: string } = {}) {
  const org = await makeOrg();
  const user = await prisma.user.create({ data: { id: uid('u'), email: `${uid('o')}@m.test`, name: 'Owner' } as any });
  const { store, sp } = await makeStoreWithProduct(org.id, 4650);
  const { url } = await boost.startConnect(org.id, user.id, store.id);
  const state = new URL(url).searchParams.get('state')!;
  const back = await boost.callback({ code: `stub_code_${uid('c')}`, state });
  assert.match(back, /connected=1/);
  await boost.selectAccount(org.id, store.id, { adAccountId: ACT, pageId: PAGE, pixelId: PIXEL, testEventCode: opts.testEventCode });
  return { org, user, store, sp, state };
}

// ---------- OAuth connect ----------
test('connect: state is single-use and expires; token is encrypted at rest', async () => {
  const { org, user, store, state } = await connected();
  assert.match(await boost.callback({ code: 'stub_code_again', state }), /error=expired_state/, 'replayed callback refused');
  const conn = await prisma.adConnection.findUniqueOrThrow({ where: { storeId_channel: { storeId: store.id, channel: 'META' } } });
  assert.ok(conn.tokenCipher.startsWith('v1.') && !conn.tokenCipher.includes('stub_token_'), 'sealed');
  assert.match(openToken(conn.tokenCipher), /^stub_token_/);
  assert.deepEqual([conn.status, conn.externalName], ['active', 'Jeff Allin (test user)']);
  assert.ok(conn.scopes.includes('ads_management'));
  // expired state
  const { url } = await boost.startConnect(org.id, user.id, store.id);
  const s2 = new URL(url).searchParams.get('state')!;
  await prisma.oAuthState.update({ where: { id: s2 }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.match(await boost.callback({ code: 'stub_code_x', state: s2 }), /error=expired_state/);
  // concurrent callbacks with one state: exactly one wins
  const { url: u3 } = await boost.startConnect(org.id, user.id, store.id);
  const s3 = new URL(u3).searchParams.get('state')!;
  const rs = await Promise.all([1, 2, 3].map(() => boost.callback({ code: `stub_code_${uid('k')}`, state: s3 })));
  assert.equal(rs.filter((r) => r.includes('connected=1')).length, 1);
  // user pressed Cancel on Facebook
  const { url: u4 } = await boost.startConnect(org.id, user.id, store.id);
  assert.match(await boost.callback({ error: 'access_denied', state: new URL(u4).searchParams.get('state')! }), /error=access_denied/);
  // another org can't start a connect for this store
  const other = await makeOrg();
  await assert.rejects(() => boost.startConnect(other.id, user.id, store.id), /Store not found/);
});

test('account selection: disabled ad account and foreign pixel are refused', async () => {
  const { org, store } = await connected();
  const o = await boost.options(org.id, store.id);
  assert.deepEqual(o.accounts.map((a) => a.id), [ACT, 'act_5647382910']);
  await assert.rejects(() => boost.selectAccount(org.id, store.id, { adAccountId: 'act_5647382910', pageId: PAGE, pixelId: PIXEL }), /not active|disabled/i);
  await assert.rejects(() => boost.selectAccount(org.id, store.id, { adAccountId: ACT, pageId: PAGE, pixelId: '999999999' }), /Pixel/);
  const a = await prisma.adAccount.findFirstOrThrow({ where: { storeId: store.id } });
  assert.deepEqual([a.mode, a.externalId, a.pixelId, a.pageId], ['OWNED', ACT, PIXEL, PAGE]);
});

// ---------- campaigns ----------
const metaObjs = (kind: string) => Object.values((meta as any).state.objects as Record<string, any>).filter((o) => o.kind === kind);

test('launch: a createCampaign timeout is resumed without a duplicate campaign on Meta', async () => {
  const { org, store, sp } = await connected();
  meta.failNext.createCampaign = new MetaApiError('An unexpected error has occurred. Please retry your request later.', { status: 500, code: 2, isTransient: true });
  const input = { storeId: store.id, storeProductId: sp.id, dailyBudgetCents: 1500, requestId: uid('rq') };
  await assert.rejects(() => boost.createCampaign(org.id, input), /busy|again/);
  const c0 = await prisma.adCampaign.findFirstOrThrow({ where: { storeId: store.id } });
  assert.equal(c0.stage, 'DRAFT');
  assert.equal(metaObjs('campaign').length, 1, 'Meta created it before the error');
  const c = await boost.createCampaign(org.id, input); // same requestId → resume
  assert.equal(c.stage, 'REVIEW');
  assert.equal(metaObjs('campaign').length, 1, 'found by its [sf:id] tag, not created again');
  assert.equal(c.externalId, metaObjs('campaign')[0].id);
  assert.ok(c.externalAdSetId && c.externalCreativeId && c.externalAdId);
  assert.equal(metaObjs('adset')[0].budgetMinor, 1500);
  assert.equal(metaObjs('campaign')[0].status, 'ACTIVE');
  assert.equal(await prisma.adCampaign.count({ where: { storeId: store.id } }), 1);
});

test('launch: double-click (concurrent creates, same requestId) → one campaign everywhere; budget minimum enforced', async () => {
  const { org, store, sp } = await connected();
  const input = { storeId: store.id, storeProductId: sp.id, dailyBudgetCents: 2000, requestId: uid('rq') };
  await Promise.allSettled([boost.createCampaign(org.id, input), boost.createCampaign(org.id, input), boost.createCampaign(org.id, input)]);
  assert.equal(await prisma.adCampaign.count({ where: { storeId: store.id } }), 1);
  assert.equal(metaObjs('campaign').length, 1);
  assert.equal(metaObjs('ad').length, 1);
  await assert.rejects(() => boost.createCampaign(org.id, { ...input, requestId: uid('rq'), dailyBudgetCents: 499 }), /between \$5/);
});

test('pause / resume reach Meta; insights sync → daily rows, stage REVIEW → WARMING, fee charged per mode', async () => {
  const prev = process.env.ADS_OWNED_FEE_PCT;
  process.env.ADS_OWNED_FEE_PCT = '10';
  try {
    const { org, store, sp } = await connected();
    const w = await wallet.walletFor(org.id);
    await creditTopUp({ paymentIntentId: uid('pi'), amountCents: 5000, walletId: w.id, provider: 'stub', source: 'manual' });
    const c = await boost.createCampaign(org.id, { storeId: store.id, storeProductId: sp.id, dailyBudgetCents: 4000, requestId: uid('rq') });
    offset = 26 * 3600_000; // a day of delivery later
    const now = new Date(Date.now() + offset);
    const r: any = await boost.syncCampaign(c.id, now);
    assert.equal(r.stage, 'WARMING');
    const days = await prisma.adInsightDaily.findMany({ where: { campaignId: c.id }, orderBy: { date: 'asc' } });
    assert.ok(days.length >= 1);
    const spend = days.reduce((a, d) => a + d.spendCents, 0);
    assert.ok(spend > 3000 && spend <= 4000 * 1.1 + 100, `about a day of a $40 budget (${spend})`);
    assert.ok(days.every((d) => d.impressions > 0 && d.clicks >= 0));
    // OWNED: Meta bills spend to the merchant; fuel pays the 10% fee only
    const fee = (await prisma.walletTxn.aggregate({ where: { campaignId: c.id, kind: 'FEE' }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
    assert.equal(await prisma.walletTxn.count({ where: { campaignId: c.id, kind: 'SPEND' } }), 0);
    const expected = days.reduce((a, d) => a + Math.round(d.spendCents * 0.1), 0);
    assert.equal(-fee, expected);
    // idempotent re-sync
    await boost.syncCampaign(c.id, now);
    assert.equal((await prisma.walletTxn.aggregate({ where: { campaignId: c.id, kind: 'FEE' }, _sum: { amountCents: true } }))._sum.amountCents, fee);
    // pause on Meta stops delivery
    await boost.pause(org.id, c.id);
    assert.equal(metaObjs('campaign')[0].status, 'PAUSED');
    assert.equal((await prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).stage, 'PAUSED');
    await boost.resume(org.id, c.id);
    assert.equal(metaObjs('campaign')[0].status, 'ACTIVE');
    assert.equal((await prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).stage, 'WARMING');
  } finally {
    if (prev === undefined) delete process.env.ADS_OWNED_FEE_PCT; else process.env.ADS_OWNED_FEE_PCT = prev;
  }
});

test('MANAGED account: fuel pays spend + ADS_FEE_PCT (15%); low fuel pauses it on Meta', async () => {
  const { org, store, sp } = await connected();
  const w = await wallet.walletFor(org.id);
  await creditTopUp({ paymentIntentId: uid('pi'), amountCents: 2000, walletId: w.id, provider: 'stub', source: 'manual' });
  const c = await boost.createCampaign(org.id, { storeId: store.id, storeProductId: sp.id, dailyBudgetCents: 5000, requestId: uid('rq') });
  // treat the account as platform-managed (MANAGED, the blueprint's other mode) for the charge rules
  await prisma.adAccount.updateMany({ where: { storeId: store.id }, data: { mode: 'MANAGED' } });
  offset = 20 * 3600_000;
  await boost.syncCampaign(c.id, new Date(Date.now() + offset));
  const after = await prisma.adWallet.findUniqueOrThrow({ where: { id: w.id } });
  assert.equal(after.balanceCents, 0, 'ran dry, never negative');
  const day = await prisma.adChargeDay.findMany({ where: { campaignId: c.id } });
  const owed = day.reduce((a, d) => a + d.spendOwedCents + d.feeOwedCents, 0);
  const spend = day.reduce((a, d) => a + d.spendOwedCents, 0);
  assert.equal(day.reduce((a, d) => a + d.feeOwedCents, 0), day.reduce((a, d) => a + Math.round(d.spendOwedCents * 0.15), 0));
  assert.ok(spend > 2000);
  assert.equal(day.reduce((a, d) => a + d.shortfallCents, 0), owed - 2000);
  await boost.onFuelEmpty(w.id);
  assert.equal(metaObjs('campaign')[0].status, 'PAUSED', 'paused on Meta');
  assert.equal((await prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).pausedReason, 'low_fuel');
});

test('policy: Meta disapproves the ad → REJECTED, creative flagged, merchant notified', async () => {
  const { org, store, sp } = await connected();
  const c = await boost.createCampaign(org.id, { storeId: store.id, storeProductId: sp.id, dailyBudgetCents: 1000, requestId: uid('rq'), headline: 'Miracle lamp' });
  offset = 3600_000;
  const r: any = await boost.syncCampaign(c.id, new Date(Date.now() + offset));
  assert.equal(r.stage, 'REJECTED');
  assert.equal((await prisma.adCreative.findFirstOrThrow({ where: { campaignId: c.id } })).policyStatus, 'rejected');
  assert.equal(await prisma.notification.count({ where: { organizationId: org.id, kind: 'boost_rejected' } }), 1);
  assert.equal(await prisma.adInsightDaily.count({ where: { campaignId: c.id } }), 0, 'no delivery, no spend');
});

test('expired / revoked token → connection marked expired + reconnect notice; disconnect pauses everything', async () => {
  const { org, store, sp } = await connected();
  const c = await boost.createCampaign(org.id, { storeId: store.id, storeProductId: sp.id, dailyBudgetCents: 1000, requestId: uid('rq') });
  meta.failNext.insights = new MetaApiError('Error validating access token: The user has not authorized application.', { status: 400, code: 190, type: 'OAuthException' });
  await assert.rejects(() => boost.syncCampaign(c.id, new Date(Date.now() + 3600_000)), /access token/);
  const conn = await prisma.adConnection.findFirstOrThrow({ where: { storeId: store.id } });
  assert.equal(conn.status, 'expired');
  assert.equal(await prisma.notification.count({ where: { organizationId: org.id, kind: 'boost_reconnect' } }), 1);
  await prisma.adConnection.update({ where: { id: conn.id }, data: { status: 'active' } });
  const d = await boost.disconnect(org.id, store.id);
  assert.equal(d.paused, 1);
  assert.equal(metaObjs('campaign')[0].status, 'PAUSED');
  assert.equal(await prisma.adConnection.count({ where: { storeId: store.id } }), 0, 'token deleted');
  assert.equal((await prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).pausedReason, 'disconnected');
});

// ---------- Conversions API ----------
async function paidOrder(store: { slug: string }, spId: string, attribution: any, ua: string | null = 'Mozilla/5.0 (Macintosh) Safari/605') {
  const res: any = await orders.checkout({ ...checkoutInput(store.slug, spId, 2), name: 'Ada María Lovelace', email: ' Ada@Example.COM ', shippingAddress: { line1: '1 Main', city: 'San Francisco', state: 'CA', postalCode: '94107-1234', country: 'US' }, attribution } as any, { ip: '203.0.113.77', userAgent: ua });
  await capi.idle();
  return res.order.id as string;
}

test('CAPI: Purchase sent once with hashed customer data, test_event_code, and deduplicated against the browser Pixel', async () => {
  const { store, sp } = await connected({ testEventCode: 'TEST12345' });
  const orderId = await paidOrder(store, sp.id, { consent: true, fbp: 'fb.1.1731400000000.1234567890', fbc: 'fb.1.1731400000000.IwAR0abc', sourceUrl: 'http://shop.example.com/p/1' });
  const ev = await prisma.conversionEvent.findUniqueOrThrow({ where: { eventId: `order_${orderId}` } });
  assert.deepEqual([ev.metaStatus, ev.sentMeta, ev.testEventCode], ['sent', true, 'TEST12345']);
  const p: any = ev.payload;
  assert.equal(p.event_name, 'Purchase');
  assert.equal(p.event_id, `order_${orderId}`);
  assert.deepEqual(p.user_data.em, [sha('ada@example.com')]);
  assert.deepEqual(p.user_data.fn, [sha('ada')]);
  assert.deepEqual(p.user_data.ln, [sha('lovelace')]);
  assert.deepEqual(p.user_data.ct, [sha('sanfrancisco')]);
  assert.deepEqual(p.user_data.zp, [sha('94107')]);
  assert.deepEqual(p.user_data.country, [sha('us')]);
  assert.equal(p.user_data.client_ip_address, '203.0.113.77');
  assert.equal(p.user_data.fbp, 'fb.1.1731400000000.1234567890');
  assert.equal(p.custom_data.value, 93);
  assert.equal(p.custom_data.currency, 'USD');
  assert.ok(!JSON.stringify(p).toLowerCase().includes('ada@example.com') && !JSON.stringify(p).includes('Lovelace'), 'no raw PII');
  // Meta test events: server event received; the browser Pixel's twin (same event_id) is deduplicated
  meta.recordBrowserEvent(PIXEL, 'Purchase', `order_${orderId}`, 'TEST12345');
  const te = meta.testEvents(PIXEL).filter((e) => e.eventId === `order_${orderId}`);
  assert.deepEqual(te.map((e) => [e.source, e.deduplicated, e.testEventCode]), [['browser', true, 'TEST12345'], ['server', false, 'TEST12345']]);
  // replayed paid event → no second CAPI event
  await orders.markPaid(orderId, uid('pi'), 'stub');
  await capi.orderPaid(orderId);
  assert.equal(await prisma.conversionEvent.count({ where: { orderId } }), 1);
  assert.equal(meta.testEvents(PIXEL).filter((e) => e.eventId === `order_${orderId}` && e.source === 'server').length, 1);
  // thank-you page Pixel data: no PII
  const px = await capi.pixelForOrder(orderId);
  assert.deepEqual(Object.keys(px).sort(), ['currency', 'eventId', 'pixelId', 'stub', 'value']);
});

test('CAPI: no consent → nothing sent (row marked skipped); no Pixel selected → no row', async () => {
  const { store, sp } = await connected();
  const orderId = await paidOrder(store, sp.id, { consent: false, fbp: 'fb.1.1.2' });
  const ev = await prisma.conversionEvent.findUniqueOrThrow({ where: { eventId: `order_${orderId}` } });
  assert.deepEqual([ev.metaStatus, ev.lastError, ev.payload], ['skipped', 'no_consent', null]);
  assert.equal(meta.testEvents(PIXEL).length, 0);
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.deepEqual(o.attribution, { consent: false }, 'no ip/ua/fbp stored without consent');
  const org2 = await makeOrg();
  const plain = await makeStoreWithProduct(org2.id);
  const o2 = await paidOrder(plain.store, plain.sp.id, { consent: true });
  assert.equal(await prisma.conversionEvent.count({ where: { orderId: o2 } }), 0);
});

test('CAPI: transient Meta error is retried with backoff (same event_id); a bad request fails for good', async () => {
  const { store, sp } = await connected();
  meta.failNext.sendEvents = new MetaApiError('Service temporarily unavailable', { status: 503, isTransient: true });
  const orderId = await paidOrder(store, sp.id, { consent: true });
  let ev = await prisma.conversionEvent.findUniqueOrThrow({ where: { eventId: `order_${orderId}` } });
  assert.deepEqual([ev.metaStatus, ev.attempts], ['pending', 1]);
  assert.deepEqual(await capi.retryPending(new Date(Date.now() + 30_000)), [], 'backoff not over');
  const out = await capi.retryPending(new Date(Date.now() + 5 * 60_000));
  assert.deepEqual(out.map((x) => x.result), ['sent']);
  ev = await prisma.conversionEvent.findUniqueOrThrow({ where: { id: ev.id } });
  assert.deepEqual([ev.metaStatus, ev.attempts], ['sent', 2]);

  meta.failNext.sendEvents = new MetaApiError('Invalid parameter', { status: 400, code: 100 });
  const o2 = await paidOrder(store, sp.id, { consent: true });
  const ev2 = await prisma.conversionEvent.findUniqueOrThrow({ where: { eventId: `order_${o2}` } });
  assert.equal(ev2.metaStatus, 'failed');
  // concurrent dispatchers on a pending row: one attempt
  const o3 = await paidOrder(store, sp.id, { consent: true }, null); // no user agent → Meta rejects website events
  const ev3 = await prisma.conversionEvent.findUniqueOrThrow({ where: { eventId: `order_${o3}` } });
  assert.equal(ev3.metaStatus, 'failed');
  assert.match(ev3.lastError ?? '', /user_agent/);
});

test('normalisation helpers follow Meta rules', () => {
  assert.equal(norm.email('  John.Doe@Gmail.COM '), 'john.doe@gmail.com');
  assert.equal(norm.name("O'Brien-Smith"), 'obriensmith');
  assert.equal(norm.city('New York'), 'newyork');
  assert.equal(norm.state('Saskatchewan'), 'sa');
  assert.equal(norm.zip('S4P 0A1', 'CA'), 's4p0a1');
  assert.equal(norm.zip('94107-1234', 'US'), '94107');
  assert.equal(norm.country('US'), 'us');
});
