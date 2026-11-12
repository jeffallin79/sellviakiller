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
const topup = await call('POST', '/fuel/topups', { amountCents: 2000, requestId: `smoke-${Date.now()}` });
ok(topup.status < 300, 'ad fuel top-up (stub)');
const w = await call('GET', '/fuel');
ok(w.json.wallet.balanceCents === 2000, 'wallet credited $20');
const ref = await call('POST', '/fuel/refunds', { topupTxnId: w.json.txns[0].id, amountCents: 500 });
ok(ref.status < 300 && ref.json.status === 'succeeded', 'ad fuel refund $5 (stub)');
const csv = await call('GET', '/export/orders.csv');
ok(csv.status === 200 && String(csv.json).includes(order.id), 'orders CSV export');
ok((await call('DELETE', `/stores/${storeId}`)).status < 300, 'soft-delete store');
console.log(`\nE2E smoke passed (${email}, store ${slug})`);
