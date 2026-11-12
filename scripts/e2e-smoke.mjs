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
// ---- slice 4: managed Boost — enable 3 channels, draft (variants/crops/policy), launch, sync, conversions ----
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mo = (await call('GET', `/boost/managed?storeId=${storeId}`)).json;
  ok(mo.feePct === 15, `managed fee ${mo.feePct}%`);
  if (mo.channels.some((c) => c.mode !== 'stub')) console.log('skip - a managed channel is live; stub path not available');
  else {
    await call('POST', '/fuel/checkout', { amountCents: 10000, requestId: `smoke-fuel4-${Date.now()}` });
    const en = (await call('POST', '/boost/managed/enable', { storeId, channels: ['META', 'GOOGLE', 'TIKTOK'] })).json;
    ok(en.channels.every((c) => c.account?.status === 'ready'), `accounts ready: ${en.channels.map((c) => `${c.channel}=${c.account?.externalId}`).join(' ')}`);
    const again = (await call('POST', '/boost/managed/enable', { storeId, channels: ['META', 'GOOGLE', 'TIKTOK'] })).json;
    ok(again.channels.every((c, i) => c.account.id === en.channels[i].account.id), 'enable twice → same accounts');
    const rq = `smoke-mb-${Date.now()}`;
    const [d1, d2] = await Promise.all([1, 2].map(() => call('POST', '/boost/managed/drafts', { storeId, storeProductId: sp.json[0].id, requestId: rq })));
    ok(d1.json.id === d2.json.id && d1.json.variants.length === 4 && d1.json.assets.length === 4, `draft: 4 variants, 4 crops, policy ${d1.json.policyResult}`);
    const png = await fetch(d1.json.assets[0].url);
    ok(png.status === 200 && png.headers.get('content-type') === 'image/png', `crop renders (${d1.json.assets[0].ratio}, ${(await png.arrayBuffer()).byteLength} B)`);
    const bad = await call('POST', `/boost/managed/groups/${d1.json.id}`, { headline: 'Miracle cure lamp' });
    ok(bad.json.policyResult === 'block', 'policy blocks a miracle claim');
    ok((await call('POST', `/boost/managed/groups/${d1.json.id}/launch`)).status === 400, 'blocked copy can’t launch');
    await call('POST', `/boost/managed/groups/${d1.json.id}`, { variantIndex: 1 });
    const fixed = await call('POST', `/boost/managed/groups/${d1.json.id}`, { variantIndex: 0, headline: 'Warm light, small rooms', body: 'Dimmable lamp that ships fast.' });
    ok(fixed.json.policyResult !== 'block', 'edited copy passes');
    const t0 = Date.now();
    const [l1, l2] = await Promise.all([1, 2].map(() => call('POST', `/boost/managed/groups/${d1.json.id}/launch`)));
    ok(l1.status < 300 && l2.status < 300, `launch (double click) → ${l1.json.status}/${l2.json.status}`);
    let g;
    for (let i = 0; i < 120 && g?.status !== 'LIVE'; i++) { g = (await call('GET', `/boost/managed/groups/${d1.json.id}`)).json; if (g.status !== 'LIVE') await sleep(500); }
    ok(g.status === 'LIVE' && g.campaigns.length === 3 && g.campaigns.every((c) => c.externalId), `live on ${g.campaigns.map((c) => c.channel).join('+')} in ${(g.launchMs / 1000).toFixed(1)} s (wall ${((Date.now() - t0) / 1000).toFixed(1)} s, target < 180 s)`);
    ok(g.launchMs < 180_000, 'pick → launch under 3 minutes');
    const ov = (await call('GET', `/boost/managed?storeId=${storeId}`)).json;
    ok(ov.channels.every((c) => c.account.capMinor > 0), `ceilings set: ${ov.channels.map((c) => `${c.channel}=${c.account.capMinor}`).join(' ')}`);
    const sy = await call('POST', '/boost/managed/sync', { storeId });
    ok(sy.status < 300 && sy.json.synced === 3, 'managed insights pulled + charged (spend + 15%)');
    const wal = (await call('GET', '/fuel/wallet')).json.wallet;
    ok(wal.balanceCents >= 0 && wal.bonusCents >= 0, `fuel never below 0 (${wal.balanceCents}¢)`);
    ok((await call('POST', `/boost/managed/groups/${g.id}/pause`)).json.campaigns.every((c) => c.stage === 'PAUSED'), 'pause all channels');
    ok((await call('POST', `/boost/managed/groups/${g.id}/resume`)).json.campaigns.every((c) => c.stage !== 'PAUSED'), 'resume all channels');
    // conversions: consented order with click ids → one server Purchase per channel + browser twins dedup'd
    const co = await call('POST', '/checkout', {
      storeSlug: slug, email: 'Buyer4@Example.com', name: 'Buyer Four', lines: [{ storeProductId: sp.json[0].id, quantity: 1 }],
      shippingAddress: { line1: '4 Main', city: 'Regina', state: 'SK', postalCode: 'S4P0A1', country: 'CA' },
      attribution: { consent: true, gclid: 'Cj0KCQ-e2e_gclid', ttclid: 'E.C.P.e2e-ttclid', ttp: 'e2e.ttp', sourceUrl: `http://${slug}.storeforge.local/` },
    }, { 'user-agent': 'Mozilla/5.0 e2e' });
    const oid = new URL(co.json.checkoutUrl).searchParams.get('orderId');
    const px = (await call('GET', `/storefront/orders/${oid}/pixel`)).json;
    ok(px.tags.map((t) => t.kind).sort().join() === 'gtag,meta,tiktok' && px.transactionId === oid, 'thank-you page gets Meta + gtag + TikTok tags');
    for (const t of px.tags) {
      const r = await call('POST', '/storefront/stub-pixel', { kind: t.kind, pixelId: t.id, eventName: t.kind === 'tiktok' ? 'CompletePayment' : t.kind === 'gtag' ? 'purchase' : 'Purchase', eventId: t.kind === 'gtag' ? oid : px.eventId });
      ok(r.status === 202, `browser ${t.kind} purchase (stub)`);
    }
    let evs;
    for (let i = 0; i < 30; i++) {
      evs = (await call('GET', `/boost/managed/events?storeId=${storeId}`)).json;
      if (evs.every((c) => c.events.some((e) => e.source === 'server' && String(e.eventId).includes(oid)))) break;
      await sleep(300);
    }
    for (const c of evs) {
      const mine = c.events.filter((e) => String(e.eventId).includes(oid));
      ok(mine.length === 2 && mine.filter((e) => !e.deduplicated).length === 1, `${c.channel}: server + browser, counted once`);
    }
  }
}
// ---- slice 5: research scores + abandoned-bag recovery ----
{
  const sleep5 = (ms) => new Promise((r) => setTimeout(r, ms));
  const rr = await call('POST', '/research/refresh');
  ok(rr.status < 300, `research refresh (${rr.json.throttled ? 'throttled' : `${rr.json.scored} scored`})`);
  const rl = (await call('GET', '/research/products?take=5&sort=score')).json;
  ok(rl.items?.length > 0 && rl.items.every((x) => x.score >= 0 && x.score <= 100), `research list: ${rl.items?.length} scored, sources ${rl.sources?.trends}/${rl.sources?.adLibrary}/${rl.sources?.llm}`);
  const rd = (await call('GET', `/research/products/${rl.items[0].productId}`)).json;
  ok(rd.score?.angles?.length > 0 && rd.score.angles.every((a) => a.policy !== 'block'), `research detail: ${rd.score?.angles?.length} angle drafts, none policy-blocked`);
  const mc = await call('POST', '/research/margin', { priceCents: 4000, costCents: 1200 });
  ok(mc.status < 300 && Number.isFinite(mc.json.profitCents), `margin calc: $40 at $12 cost → ${(mc.json.profitCents / 100).toFixed(2)} profit`);

  ok((await call('PATCH', `/stores/${storeId}/cart-recovery`, { enabled: true })).status === 400, 'reminders cannot be enabled without a mailing address');
  const set = await call('PATCH', `/stores/${storeId}/cart-recovery`, { enabled: true, mailingAddress: '1 Smoke St, Regina SK S4P 0A1, Canada' });
  ok(set.json.settings?.ready === true, 'reminders on with a mailing address');
  const token = `e2e${Date.now().toString(36)}abcdefghijkl`;
  const shopper = `bag${Date.now()}@example.com`;
  const lines = [{ storeProductId: sp.json[0].id, quantity: 2 }];
  const noConsent = await call('POST', '/storefront/carts', { storeSlug: slug, token: token + 'n', email: shopper, consent: false, lines });
  ok(noConsent.json.stored === false, 'no opt-in → nothing stored');
  const cap = await call('POST', '/storefront/carts', { storeSlug: slug, token, email: shopper, name: 'Bag Tester', consent: true, lines });
  ok(cap.json.stored === true && cap.json.id, 'opt-in bag captured');
  const again = await call('POST', '/storefront/carts', { storeSlug: slug, token, email: shopper, consent: true, lines });
  ok(again.json.id === cap.json.id, 'same token updates the same bag');
  // Make the bag look 2 h old so the sweeper (CART_SWEEP_MS) picks it up. Needs local psql.
  const { execFileSync } = await import('node:child_process');
  let aged = false;
  try {
    execFileSync('psql', [process.env.E2E_DATABASE_URL ?? 'postgresql://storeforge@127.0.0.1:5432/storeforge', '-qc', `UPDATE "Cart" SET "lastActivityAt" = (now() AT TIME ZONE 'UTC') - interval '2 hours' WHERE id = '${cap.json.id.replace(/[^a-z0-9]/gi, '')}'`], { stdio: 'pipe' });
    aged = true;
  } catch { console.log('skip - psql unavailable, reminder delivery not checked'); }
  if (aged) {
    let mail;
    for (let i = 0; i < 100 && mail?.status !== 'SENT'; i++) {
      mail = (await call('GET', `/emails?storeId=${storeId}`)).json.items.find((m) => m.kind === 'CART_REMINDER_1');
      if (mail?.status !== 'SENT') await sleep5(1000);
    }
    ok(mail?.status === 'SENT', `reminder 1 sent by the sweeper (${mail?.status ?? 'not queued'}; start the API with CART_SWEEP_MS≈3000)`);
    const html = String((await call('GET', `/emails/${mail.id}/html`)).json);
    ok(html.includes('1 Smoke St') && /Unsubscribe/.test(html), 'reminder has the postal address and an unsubscribe link');
    const unsub = html.match(/href="([^"]*\/api\/email\/unsubscribe\?[^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
    const rec = html.match(/href="([^"]*[?&]recover=[^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
    const ru = new URL(rec);
    const restored = await call('GET', `/storefront/carts/recover?id=${ru.searchParams.get('recover')}&t=${ru.searchParams.get('t')}`);
    ok(restored.status === 200 && restored.json.lines?.[0]?.quantity === 2, 'recover link restores the bag');
    ok((await call('GET', `/storefront/carts/recover?id=${ru.searchParams.get('recover')}&t=bad${ru.searchParams.get('t').slice(3)}`)).status >= 400, 'tampered recover link rejected');
    const uu = new URL(unsub);
    const path = uu.pathname.replace(/^\/api/, '') + uu.search;
    const pageGet = await fetch(API + path);
    ok(pageGet.status === 200 && /Unsubscribe<\/button>/.test(await pageGet.text()), 'unsubscribe GET shows a button, does not unsubscribe');
    ok((await call('GET', `/stores/${storeId}/cart-recovery`)).json.stats.unsubscribed === 0, 'still subscribed after GET');
    const one = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    ok(one.status === 200, 'RFC 8058 one-click unsubscribe');
    ok((await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })).status === 200, 'one-click unsubscribe is idempotent');
    const ov = (await call('GET', `/stores/${storeId}/cart-recovery`)).json;
    ok(ov.stats.unsubscribed === 1 && ov.carts.find((c) => c.id === cap.json.id)?.status === 'OPTED_OUT', 'bag opted out, address suppressed');
    const blocked = await call('POST', '/storefront/carts', { storeSlug: slug, token: token + 'z', email: shopper, consent: true, lines });
    ok(blocked.json.stored === false && blocked.json.reason === 'unsubscribed', 'unsubscribed address is not captured again');
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
