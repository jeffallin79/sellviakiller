#!/usr/bin/env node
// HTTP smoke of the full merchant path against a running API (stub payments by default).
//   API_URL=http://127.0.0.1:4000 node scripts/e2e-smoke.mjs
// With WEBHOOK_SECRET set (and the API running with STRIPE_SECRET_KEY=sk_test_… +
// STRIPE_WEBHOOK_SECRET), it also checks the raw-body signature path over real HTTP.
import { createHmac } from 'node:crypto';
const API = (process.env.API_URL ?? 'http://127.0.0.1:4000') + '/api';
let cookie = '';
async function call(method, path, body, headers = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3001', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const ok = (c, msg) => { if (!c) { console.error('FAIL:', msg); process.exit(1); } console.log('ok  -', msg); };

if (process.env.WEBHOOK_SECRET) {
  const payload = JSON.stringify({ id: `evt_smoke_${Date.now()}`, object: 'event', type: 'smoke.test', livemode: false, data: { object: {} } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', process.env.WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  const good = await call('POST', '/webhooks/stripe', payload, { 'stripe-signature': `t=${t},v1=${sig}` });
  ok(good.status === 200 && good.json.received, `signed webhook accepted over HTTP (${good.status})`);
  const replay = await call('POST', '/webhooks/stripe', payload, { 'stripe-signature': `t=${t},v1=${sig}` });
  ok(replay.json.duplicate === true, 'replayed webhook reported duplicate');
  const bad = await call('POST', '/webhooks/stripe', payload.replace('smoke', 'evil'), { 'stripe-signature': `t=${t},v1=${sig}` });
  ok(bad.status === 400, `tampered webhook rejected (${bad.status})`);
  const none = await call('POST', '/webhooks/stripe', payload);
  ok(none.status === 400, `unsigned webhook rejected (${none.status})`);
  process.exit(0);
}

const email = `smoke${Date.now()}@storeforge.local`;
const health = await call('GET', '/health');
ok(health.json.db === 'ok', `health db ok, payments=${health.json.payments}/${health.json.paymentsMode}`);
ok((await call('POST', '/auth/bootstrap', { email, password: 'password123', name: 'Smoke', accountName: 'Smoke Co' })).status < 300, 'bootstrap merchant');
ok((await call('POST', '/auth/sign-in/email', { email, password: 'password123' })).status === 200, 'sign in');
const sub = await call('POST', '/billing/subscribe', { planId: 'starter' });
ok(sub.json.subscription?.status === 'ACTIVE', `subscribe (${sub.json.mode})`);
const payout = await call('POST', '/payouts/onboard');
ok(payout.status < 300 && payout.json.url, 'payout onboarding link');
ok((await call('GET', '/payouts/status')).json.ready === true, 'payouts ready (stub)');
const slug = `smoke${Date.now().toString(36)}`;
const store = await call('POST', '/stores', { name: 'Smoke Store', slug });
ok(store.status < 300, `provision store ${slug}`);
const storeId = store.json.store?.id ?? store.json.id;
const cat = await call('GET', '/catalog/products?take=3');
ok(cat.json.items?.length === 3, `catalog has ${cat.json.total} SKUs`);
const imp = await call('POST', `/stores/${storeId}/import`, { productIds: cat.json.items.map((p) => p.id), markupPercent: 50 });
ok(imp.json.imported === 3, '1-click import 3 products');
const sp = await call('GET', `/storefront/${slug}/products`);
ok(sp.json.length === 3, 'storefront lists 3 products');
const co = await call('POST', '/checkout', {
  storeSlug: slug, email: 'buyer@example.com', name: 'Buyer', lines: [{ storeProductId: sp.json[0].id, quantity: 1 }],
  shippingAddress: { line1: '1 Main', city: 'Regina', state: 'SK', postalCode: 'S4P0A1', country: 'CA' },
});
ok(co.json.mode === 'stub' && /stub_paid=1/.test(co.json.checkoutUrl), 'checkout (stub) returns thank-you URL');
const orders = await call('GET', '/orders');
const order = orders.json[0];
ok(order && order.provider === 'stub' && order.providerPaymentId, `order in admin: ${order?.status}`);
if (order.status === 'AWAITING_MERCHANT_APPROVAL') {
  ok((await call('POST', `/fulfillment/orders/${order.id}/approve`)).status < 300, 'approve fulfillment');
}
const after = (await call('GET', `/orders/${order.id}`)).json;
ok(after.fulfillment?.trackingNumber, `tracking ${after.fulfillment?.carrier} ${after.fulfillment?.trackingNumber} (${after.status})`);
// ---- slice 2: order emails + refunds ----
const mails = (await call('GET', `/emails?orderId=${order.id}`)).json;
const kinds = mails.items.map((m) => m.kind);
ok(kinds.includes('ORDER_CONFIRMED') && kinds.includes('ORDER_SHIPPED'), `order emails: ${kinds.join(', ')} via ${mails.transport}`);
const shippedMail = mails.items.find((m) => m.kind === 'ORDER_SHIPPED');
const shippedHtml = (await call('GET', `/emails/${shippedMail.id}/html`)).json;
ok(String(shippedHtml).includes(after.fulfillment.trackingNumber), 'shipped email carries the tracking number');
// QA round 2 #1: confirmation goes out via the outbox (not awaited by markPaid) — wait for SENT
{
  const t0 = Date.now();
  let conf;
  while (Date.now() - t0 < 15_000) {
    conf = (await call('GET', `/emails?orderId=${order.id}`)).json.items.find((m) => m.kind === 'ORDER_CONFIRMED');
    if (conf?.status === 'SENT') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  ok(conf?.status === 'SENT' && after.fulfillment, `fulfilment routed + confirmation delivered via outbox (${conf?.status})`);
}
const rf = await call('POST', `/orders/${order.id}/refunds`, { amountCents: 100, requestId: `smoke-refund-${Date.now()}` });
ok(rf.status < 300 && rf.json.status === 'succeeded', 'partial refund $1 (stub)');
ok((await call('GET', `/emails?orderId=${order.id}`)).json.items.some((m) => m.kind === 'ORDER_REFUNDED'), 'refund email');
ok((await call('POST', `/orders/${order.id}/refunds`, { amountCents: 10_000_000, requestId: `smoke-over-${Date.now()}` })).status === 400, 'over-refund rejected');
// ---- slice 2: custom domain (stub DNS/TLS) ----
const host = `shop-${slug}.example.com`;
const dom = await call('POST', '/domains', { storeId, host });
ok(dom.status < 300 && dom.json.status === 'PENDING_DNS' && dom.json.records.length >= 2, `domain added, ${dom.json.records.map((r) => r.type).join('+')} records`);
const cfg = (await call('GET', '/domains/config')).json;
if (cfg.dnsMode === 'stub') {
  ok((await call('GET', `/storefront/resolve-host?host=${host}`)).status === 404, 'unverified domain not served');
  await call('POST', `/domains/${dom.json.id}/dev/simulate-dns`);
  const t0 = Date.now();
  let st = '';
  while (Date.now() - t0 < 90_000) {
    st = (await call('POST', `/domains/${dom.json.id}/check`)).json.status;
    if (st === 'ACTIVE') break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  ok(st === 'ACTIVE', `domain ACTIVE ${Math.round((Date.now() - t0) / 1000)}s after DNS (stub TLS)`);
  const rh = await call('GET', `/storefront/resolve-host?host=${host}`);
  ok(rh.json.slug === slug && rh.json.kind === 'custom', 'host routes to the store');
  if (!process.env.DOMAIN_TLS_ASK_TOKEN) ok((await call('GET', `/domains/tls-ask?domain=${host}`)).status === 200, 'tls-ask allows the verified host');
  ok((await call('DELETE', `/domains/${dom.json.id}`)).status < 300, 'domain removed');
} else {
  console.log('skip - DNS is live; simulate path not available');
}
const topup = await call('POST', '/fuel/topups', { amountCents: 2000, requestId: `smoke-${Date.now()}` });
ok(topup.status < 300, 'ad fuel top-up (stub)');
const w = await call('GET', '/fuel');
ok(w.json.wallet.balanceCents === 2000, 'wallet credited $20');
const ref = await call('POST', '/fuel/refunds', { topupTxnId: w.json.txns[0].id, amountCents: 500 });
ok(ref.status < 300 && ref.json.status === 'succeeded', 'ad fuel refund $5 (stub)');
// ---- slice 3: Ad Fuel wallet (Checkout top-up, idempotent) + auto-reload settings ----
{
  const rq = `smoke-fuel-${Date.now()}`;
  const before = (await call('GET', '/fuel/wallet')).json.wallet.balanceCents;
  const c1 = await call('POST', '/fuel/checkout', { amountCents: 5000, requestId: rq });
  ok(c1.status < 300 && c1.json.credited === true, `fuel checkout $50 (${c1.json.mode})`);
  await call('POST', '/fuel/checkout', { amountCents: 5000, requestId: rq });
  const fw = (await call('GET', '/fuel/wallet')).json;
  ok(fw.wallet.balanceCents === before + 5000, 'same requestId twice → credited once');
  ok(fw.ledger[0].kind === 'TOPUP' && fw.ledger[0].balanceAfterCents === fw.wallet.balanceCents, 'ledger row carries the running balance');
  const st = await call('POST', '/fuel/settings', { autoReloadEnabled: true, thresholdCents: 2000, autoReloadCents: 2500 });
  ok(st.status < 300 && st.json.wallet.autoReloadEnabled && st.json.wallet.card, `auto-reload on (${st.json.wallet.card?.label})`);
}
// ---- slice 3: Boost — stub Meta connect (OAuth), account pick, launch, sync, pause/resume ----
{
  const ov = (await call('GET', `/boost?storeId=${storeId}`)).json;
  if (ov.mode !== 'stub') console.log('skip - Meta is live; stub OAuth path not available');
  else {
    const start = (await call('POST', '/boost/meta/connect', { storeId })).json;
    const u = new URL(start.url);
    const state = u.searchParams.get('state');
    const cb = new URL(u.searchParams.get('redirect_uri'));
    cb.searchParams.set('code', `stub_code_e2e${Date.now()}`); cb.searchParams.set('state', state);
    const r1 = await fetch(cb, { redirect: 'manual' });
    ok(r1.status === 302 && /connected=1/.test(r1.headers.get('location')), 'Meta OAuth callback → connected');
    const r2 = await fetch(cb, { redirect: 'manual' });
    ok(/expired_state/.test(r2.headers.get('location') ?? ''), 'replayed OAuth state refused');
    const opts = (await call('GET', `/boost/meta/options?storeId=${storeId}`)).json;
    const sel = await call('POST', '/boost/meta/account', { storeId, adAccountId: opts.adAccountId, pageId: opts.pages[0].id, pixelId: opts.pixels[0].id, testEventCode: 'TEST_E2E' });
    ok(sel.status < 300, `ad account ${opts.adAccountId}, pixel ${opts.pixels[0].id}`);
    const rq = `smoke-camp-${Date.now()}`;
    const body = { storeId, storeProductId: sp.json[0].id, dailyBudgetCents: 2000, requestId: rq };
    const [a, b] = await Promise.all([call('POST', '/boost/campaigns', body), call('POST', '/boost/campaigns', body)]);
    const camps = (await call('GET', `/boost?storeId=${storeId}`)).json.campaigns;
    ok(a.status < 300 && b.status < 300 && camps.length === 1 && camps[0].externalId, `double-submit → one campaign on Meta (${camps[0]?.stage})`);
    const sy = await call('POST', '/boost/sync', { storeId });
    ok(sy.status < 300 && sy.json.synced === 1, 'insights pulled + fuel charged');
    const wal = (await call('GET', '/fuel/wallet')).json.wallet;
    ok(wal.balanceCents >= 0 && wal.bonusCents >= 0, `fuel never below 0 (${wal.balanceCents}¢, fee ${ov.feePct}%)`);
    const cid = camps[0].id;
    ok((await call('POST', `/boost/campaigns/${cid}/pause`)).json.stage === 'PAUSED', 'pause');
    ok(['REVIEW', 'WARMING', 'STEADY'].includes((await call('POST', `/boost/campaigns/${cid}/resume`)).json.stage), 'resume');
    // ---- CAPI: consented order → server Purchase; browser Pixel with the same id → dedup'd ----
    const fbp = `fb.1.${Date.now()}.12345`;
    const co2 = await call('POST', '/checkout', {
      storeSlug: slug, email: 'Buyer2@Example.com', name: 'Buyer Two', lines: [{ storeProductId: sp.json[1].id, quantity: 1 }],
      shippingAddress: { line1: '2 Main', city: 'Regina', state: 'SK', postalCode: 'S4P0A1', country: 'CA' },
      attribution: { consent: true, fbp, sourceUrl: `http://${slug}.storeforge.local/` },
    }, { 'user-agent': 'Mozilla/5.0 e2e' });
    const oid = new URL(co2.json.checkoutUrl).searchParams.get('orderId');
    let ev;
    for (let i = 0; i < 30 && ev?.metaStatus !== 'sent'; i++) {
      ev = (await call('GET', `/boost/events?storeId=${storeId}`)).json.server.find((e) => e.orderId === oid);
      if (ev?.metaStatus !== 'sent') await new Promise((r) => setTimeout(r, 300));
    }
    ok(ev?.metaStatus === 'sent' && ev.eventId === `order_${oid}` && ev.testEventCode === 'TEST_E2E', `CAPI Purchase sent (${ev?.eventId}, test code)`);
    const px = (await call('GET', `/storefront/orders/${oid}/pixel`)).json;
    ok(px.eventId === ev.eventId && !('email' in px), 'thank-you pixel gets the same event id, no PII');
    ok((await call('POST', '/storefront/stub-pixel', { pixelId: px.pixelId, eventName: 'Purchase', eventId: px.eventId })).status === 202, 'browser Pixel Purchase (stub)');
    const te = (await call('GET', `/boost/events?storeId=${storeId}`)).json.testEvents.events.filter((e) => e.eventId === ev.eventId);
    ok(te.length === 2 && te.some((e) => e.source === 'server') && te.some((e) => e.source === 'browser' && e.deduplicated), "Test Events: server + browser, browser dedup'd");
    ok((await call('POST', '/boost/meta/disconnect', { storeId })).status < 300, 'disconnect Meta');
  }
}
const csv = await call('GET', '/export/orders.csv');
ok(csv.status === 200 && String(csv.json).includes(order.id), 'orders CSV export');
// ---- QA round 2 #3: storefront ignores X-Forwarded-Host from an untrusted peer ----
// (node:http, because fetch() won't send a custom Host header)
{
  const { request } = await import('node:http');
  const u = new URL(process.env.STOREFRONT_ORIGIN ?? 'http://127.0.0.1:3000');
  const get = (headers) => new Promise((res) => {
    const rq = request({ host: u.hostname, port: u.port || 80, path: '/', method: 'GET', headers }, (r) => { r.resume(); res(r.statusCode); });
    rq.on('error', () => res(null));
    rq.end();
  });
  const spoof = await get({ Host: 'unknown-shop.example.org', 'X-Forwarded-Host': `${slug}.storeforge.local`, 'x-sf-peer': '127.0.0.1;forged' });
  if (spoof === null) console.log('skip - storefront not running');
  else {
    ok(spoof === 404, `spoofed X-Forwarded-Host ignored (routed by Host → ${spoof})`);
    const real = await get({ Host: `${slug}.storeforge.local` });
    ok(real !== 404 && real !== null, `same shop via its Host header → ${real}`);
  }
}

ok((await call('DELETE', `/stores/${storeId}`)).status < 300, 'soft-delete store');
console.log(`\nE2E smoke passed (${email}, store ${slug})`);
