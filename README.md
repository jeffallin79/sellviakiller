# StoreForge

Turnkey multi-tenant dropshipping ecommerce (Sellvia competitor).  
**Payments: Stripe** (switched from Square on 2026-11-12 — Billing for plans, Connect Express for merchant payouts, PaymentIntents for Ad Fuel). Stub mode until keys exist.

Authoritative briefs: [`PHASE1_BLUEPRINT.md`](./PHASE1_BLUEPRINT.md) (current), [`BUILDER_HANDOFF.md`](./BUILDER_HANDOFF.md) (Phase 0).

## Stack

| App / package | Tech |
| --- | --- |
| `apps/storefront` | Next.js App Router (customer, subdomain) |
| `apps/admin` | Next.js App Router (merchant dashboard) |
| `apps/api` | NestJS + OpenAPI (`/docs`) |
| `packages/db` | Prisma + Postgres |
| `packages/shared` | Zod schemas + types + supplier interface |
| Jobs | Redis + BullMQ (inline fallback if Redis down) |
| Auth | Better Auth (email/password) |
| Payments | Stripe (`apps/api/src/payments`: `PaymentProvider` interface, Stripe + stub impls) |

## Quick start

```bash
# 1) Infra
cp .env.example .env
docker compose up -d          # Postgres :5432 + Redis :6379

# 2) Install
pnpm install

# 3) DB
pnpm db:generate
pnpm db:deploy                # apply prisma/migrations
pnpm db:seed                  # plans + suppliers + ~300 fixture SKUs

# 4) Run (three terminals, or turbo)
pnpm --filter @storeforge/api dev          # :4000  OpenAPI http://localhost:4000/docs
pnpm --filter @storeforge/admin dev        # :3001
pnpm --filter @storeforge/storefront dev   # :3000
# or: pnpm dev
```

### /etc/hosts (subdomain stores)

```
127.0.0.1 demo.storeforge.local
```

Then open `http://demo.storeforge.local:3000` after provisioning slug `demo`.  
Path fallback works without hosts: `http://localhost:3000/s/demo`.

## Demo path (no API keys)

1. Admin http://localhost:3001/signup → **Launchpad** (setup tasks: plan, payouts, store, products, first order)
2. **Billing** → choose **Starter $29** (stub activates without `STRIPE_SECRET_KEY`) · Launchpad → **Set up payouts** (stub)
3. **Stores** → create slug `demo`
4. **Shelf** → tick products → **Add to store** (cost, your price at +50%, what you keep, real ETA)
5. Storefront http://localhost:3000/s/demo → add to bag → checkout (stub marks PAID, no card)
6. **Dispatch** → **Send to supplier** → CJ stub returns tracking → SHIPPED
7. **Emails** → the confirmation and shipped (with tracking) emails, as the customer sees them (dev outbox)
8. **Dispatch** → **Refund** (partial or full) → refund email · **Domains** → add `shop.example.com` → **Simulate DNS (dev)** → live in ~20 s
9. **Ad Fuel** shows the wallet (top-up/refund are API-only for now)
10. Export CSV: Shelf/Dispatch **Export CSV** (`/api/export/products.csv`, `/api/export/orders.csv`)

Soft-delete stores from Stores page — **never hard-deletes** on cancel.

## Blockers / secrets

| Env | Required for | Without it |
| --- | --- | --- |
| `DATABASE_URL` / `REDIS_URL` | Boot | Apps won't persist / jobs inline |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER/GROWTH/SCALE` | Stripe Billing, Connect checkout, Ad Fuel, webhooks | **Stub mode** — local ACTIVE sub, instant payout account, instant PAID checkout, instant fuel credit |
| `CJ_API_KEY` (+ email/password) | Live CJ catalog sync / fulfill | **Fixtures** via `pnpm db:seed` (`USE_CATALOG_FIXTURES=true`). Spocket/Zendrop stay stubs. |
| `BETTER_AUTH_SECRET` | Auth cookies | Dev default (change before deploy) |
| `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS` (verified sending domain) | Delivering order emails | **Dev outbox** — rendered + saved to `.outbox/`, readable in admin → Emails |
| `DOMAIN_DNS_MODE=live`, `DOMAIN_TLS_PROVIDER=caddy\|vercel` (+ `DOMAIN_TLS_ASK_TOKEN` or `DOMAIN_PROVIDER_TOKEN`/`VERCEL_PROJECT_ID`), `DOMAIN_CNAME_TARGET`, `DOMAIN_APEX_IPS` | Real custom domains | **Stub** — no DNS lookups, simulated certificate; "Simulate DNS" in admin |

Set `USE_CATALOG_FIXTURES=false` and `CJ_API_KEY=…` when Jeff provides CJ credentials.

## Phase 0 acceptance

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Merchant sign up / sign in | Works (Better Auth) |
| 2 | Subscribe (Starter) | Stub OK / Stripe Checkout + webhook `/api/webhooks/stripe` |
| 3 | Provision one store `{slug}.storeforge.local` | Works |
| 4 | Seed 200–500 SKUs | Fixtures (~300); CJ live when keyed |
| 5 | 1-click import catalog → store | Works |
| 6 | Customer checkout | Stub OK / Stripe Checkout destination charge to merchant's Express account |
| 7 | Order in merchant admin | Works |
| 8 | Fulfill approve/auto → SupplierAdapter | CJ impl (stub fulfill without keys); Spocket/Zendrop stubs |
| 9 | Order list + status + tracking | Works |
| 10 | Soft-delete + CSV export; no hard-delete | Works |

## Out of scope (do not build yet)

Research scores, abandoned cart, custom domains, ads, academy, digital products, store marketplace, Shopify.

## Monorepo scripts

```bash
pnpm docker:up | docker:down
pnpm db:generate | db:push | db:seed
pnpm dev | build
./scripts/demo-flow.sh   # API smoke only (bootstrap + health)
node scripts/e2e-smoke.mjs   # full HTTP path: signup → plan → payouts → store → import → checkout → fulfil → Ad Fuel → export
pnpm test                # API tests (fresh schema in storeforge_test, migrations applied from scratch)
```

`ALLOW_STUB_PAY=true` enables authenticated `POST /api/orders/:id/stub-pay` for local demos. Leave unset/false in production (endpoint returns 404).

> **Testers:** start from `.env.example`, never copy the build box's `.env` — it is a local demo file with `ALLOW_STUB_PAY=true` and dev-only settings.

## License

Private — StoreForge Phase 0 scaffold.


## Domain note

Merchant tenant model is named **Organization** in Prisma (Better Auth reserves `Account` for credential/OAuth links). Admin API still returns `memberships[].account` for UI compatibility.

## Verified on this box (2026-09-18)

Without Docker/Redis/Stripe keys/`CJ_*`:
- Embedded Postgres via `.local-bin/pgsql` + `scripts/start-local-postgres.sh`
- BullMQ falls back to **inline** jobs when Redis is down
- Full path: signup → stub plan → stub payouts → provision store → import SKUs → checkout (PAID stub) → approve → CJ stub tracking `SHIPPED` → Ad Fuel top-up/refund → CSV export

Prefer `docker compose up -d` on Jeff's machine for Postgres+Redis.



## Payments (Stripe) — Phase 1 step 0

| Flow | How |
| --- | --- |
| SaaS plans | `POST /api/billing/subscribe` → Stripe Checkout (subscription). Row turns ACTIVE only from verified webhooks; `POST /api/billing/portal` → Customer Portal |
| Merchant payouts | `POST /api/payouts/onboard` → Express account (one per merchant) + Account Link; `GET /api/payouts/status` |
| Storefront checkout | Checkout Session, destination charge (`transfer_data.destination` + `on_behalf_of`), `application_fee_amount` only if `PLATFORM_FEE_BPS` > 0 (default 0) |
| Ad Fuel | `POST /api/fuel/topups` → platform PaymentIntent (`setup_future_usage=off_session`); credited from `payment_intent.succeeded`; `POST /api/fuel/refunds` (unspent, ≤90 days) |
| Webhooks | `POST /api/webhooks/stripe` (platform, `STRIPE_WEBHOOK_SECRET`) and `/api/webhooks/stripe/connect` (`STRIPE_CONNECT_WEBHOOK_SECRET`). Signature required; event id dedupe in `WebhookEvent`; every handler idempotent; subscriptions re-read from Stripe so order/replays don't matter; live events ignored by a test-key server |

Platform webhook events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.created/updated/deleted/paused/resumed`, `invoice.paid`, `invoice.payment_failed`, `payment_intent.succeeded`, `refund.created/updated/failed`, `charge.dispute.created/updated/closed/funds_withdrawn/funds_reinstated`. Connect endpoint: `account.updated`.

Live keys (`sk_live_`) are refused unless `STRIPE_ALLOW_LIVE=true`.

**Existing dev DB created with `db push` (Phase 0)?** Mark the baseline as applied, then deploy:
`cd packages/db && npx prisma migrate resolve --applied 20260918000000_phase0_baseline && npx prisma migrate deploy`.
The second migration renames the Phase 0 payment columns to provider-neutral ones (data kept, legacy rows tagged `provider='square'`).

### Payment hardening (QA round 1)

- **Webhook claim:** the worker that inserts the `WebhookEvent` row owns it (lease in `lockedUntil`); concurrent deliveries of the same event get 200 without dispatching. A failed attempt releases the lease so Stripe's retry can take it.
- **Exactly-once PAID:** `markPaid` is a conditional update (`status = PENDING_PAYMENT`); fulfillment is enqueued only by the caller whose update changed the row.
- **Mismatch:** a paid event whose amount/currency/checkout id doesn't match the order flags the order (`Order.flag = payment_mismatch`), raises merchant + platform notifications, logs at error level, and answers 409 so the event stays unresolved and retried.
- **Ad Fuel refunds:** reserve + pending `WalletTxn` in one transaction; same idempotency key on every retry; on timeout the outcome is `unknown` and fuel stays reserved; the reconciler (`FUEL_RECONCILE_MS`, default 10 min) looks the refund up on Stripe by metadata and only restores fuel on a confirmed failure.
- **DB guard:** CHECK constraints `AdWallet_balance_nonnegative` / `AdWallet_bonus_nonnegative`.
- **Disputes:** `Dispute` rows; order flagged `dispute_open` / `dispute_lost`, store `riskFlag = open_disputes:N`; merchant + platform `Notification`s (`GET /api/notifications`). Evidence is submitted in the Stripe Dashboard for now.

## Phase 1 · Slice 1 — design system & reskin

- `packages/ui` (`@storeforge/ui`): Garnet & Saffron tokens (`tokens.css`, RGB-channel CSS variables; role tokens switch under `[data-theme='dark']`), `base.css` primitives, self-hosted OFL fonts via Fontsource, Phosphor duotone icons (`icons.tsx`), `ThemeToggle` + `ThemeScript` (localStorage `sf-theme`), `ProductImage` with branded fallback, Tailwind preset for future use.
- AA contrast is tested: `pnpm --filter @storeforge/ui test` (pairs from `brand/contrast.txt` plus every text/UI pair in both themes).
- No hard-coded colours outside `tokens.css`: root `eslint.config.mjs` (TS/TSX) and `packages/ui/scripts/check-colors.mjs` (CSS) run in each app's `pnpm lint`.
- Admin routes: `/launchpad`, `/shelf`, `/dispatch`, `/boost` (placeholder until ad platforms approve), `/fuel` (Ad Fuel), `/stores`, `/billing`; old `/dashboard/*` URLs redirect.
- Storefront: `/s/[slug]` (shop), `/s/[slug]/p/[id]` (product), cart drawer + checkout, `/checkout/complete`.
- Fonts (OFL 1.1) and icons (MIT): see `NOTICE` and `licenses/`.



## Phase 1 · Slice 2 — custom domains & order emails

**Domains** (`Domain(storeId, host, status, verifiedAt, …)`, admin → Domains, API `/api/domains`):

- Merchant adds a host → two records: `TXT _storeforge.<host> = storeforge-verify=<token>` (ownership) and `CNAME <host> → DOMAIN_CNAME_TARGET` (root domains: `A → DOMAIN_APEX_IPS`, or ALIAS/flattening to the target).
- States `PENDING_DNS → ISSUING_TLS → ACTIVE`, or `FAILED` (no DNS within 72 h, CA error, or no cert within 30 min; **Check again** restarts). An in-process sweeper (`DOMAIN_SWEEP_MS`, compare-and-set claim so several API instances are safe) checks every 30 s for the first 10 min, then 2 min, then 15 min; certificates are polled every 15 s; ACTIVE domains are re-checked every 12 h and warn (never flap offline) if DNS drifts.
- TLS providers: `stub` (simulated, issues after `DOMAIN_STUB_TLS_DELAY_MS`), `caddy` (on-demand TLS gated by `GET /api/domains/tls-ask`, see `infra/Caddyfile.example`), `vercel` (Vercel Domains API).
- Routing: the storefront middleware asks `GET /api/storefront/resolve-host` (cached 60 s, misses 15 s) and rewrites to the shop; `/s/<slug>` on a custom host 308s to the clean URL, the platform subdomain and secondary/www-twin hosts 308 to the primary domain, unknown hosts get a branded 404. Checkout return URLs and email links use the primary domain.
- Up to 3 domains per store; a host can belong to one store only.

**Order emails** (`EmailMessage`, queue `email.send`, admin → Emails):

- Triggers: **confirmation** when an order becomes PAID (stub, Checkout webhook or async payment — once, whatever replays), **shipped** with carrier, tracking number and carrier link when tracking first appears, **delivered**, and **refund** (each partial refund gets its own email). Each trigger has a unique `dedupeKey`, so webhook replays and repeated tracking polls never double-send.
- Sending: Resend REST API with `Idempotency-Key: sf-email-<id>` when `RESEND_API_KEY` is set, otherwise the dev outbox. Up to 5 attempts with backoff; 4xx from Resend is permanent. Failures never block the order. Merchants can **Send again**.
- Brand: the templates inline the Garnet & Saffron hexes, read at runtime from `packages/ui/tokens.css` (tests enforce that every colour in an email is a token). From = `"<Shop name>" <EMAIL_FROM_ADDRESS>`, Reply-To = shop owner.

**Merchant refunds** (`OrderRefund`, `POST /api/orders/:id/refunds {amountCents?, reason?, requestId}`, Dispatch → Refund): amount is reserved atomically (never over-refunds under concurrency), `requestId` makes retries idempotent, Stripe refunds use `reverse_transfer` + `refund_application_fee` and an idempotency key, outcome-unknown errors are found again by metadata, and `refund.*` webhooks settle pending refunds (failure releases the amount; a refund that fails after succeeding flags the order). Fully refunded orders become `REFUNDED` and can't be sent to the supplier.

### Slice 2 hardening (QA round 2)

- **Paid → fulfilment → email is crash-safe.** `markPaid` routes fulfilment right after the paid write (BullMQ `jobId route-<order>`, or inline), then only writes the confirmation's outbox row; delivery runs on `email.send` / in the background and never delays fulfilment. Sends hold a lease (`EmailMessage.lockedUntil`), so the worker, the inline send and the sweeper never double-deliver. `OrdersSweeper` (`ORDER_SWEEP_MS`, 60 s) routes PAID orders with no fulfilment, recreates missing confirmations, resends stuck QUEUED emails with backoff, and reconciles order refunds.
- **Order refund reconciler:** refunds stuck `pending`/`unknown` (amount reserved) are looked up on Stripe (by id, or resubmitted with the same idempotency key, which first searches by metadata). Claimed per row; alerts merchant + platform once after 24 h.
- **Storefront host trust:** `X-Forwarded-Host` is honoured only when the TCP peer is on `TRUSTED_PROXIES`; otherwise `Host`. `pnpm start` runs `apps/storefront/server.mjs`, which stamps the real peer with a per-boot token the middleware verifies (a client-sent stamp is overwritten; plain `next start` = never trusted).
- **TLS:** `DOMAIN_TLS_PROVIDER=caddy` without a 24+ char `DOMAIN_TLS_ASK_TOKEN` (or `vercel` without its token/project) refuses to boot; `tls-ask` fails closed. The HTTPS check connects only to `Domain.verifiedIp` (the edge IP DNS verification matched) with SNI/Host = the domain and normal certificate validation, no DNS at probe time, and never to private / loopback / link-local / CGNAT / reserved ranges.
- Email subjects (and To/Reply-To at send time) are stripped of CR/LF and control characters. DB CHECK `Order_refunded_within_paid`: `0 <= refundedCents <= totalCents`.
- Seed images are bundled SVGs (`apps/*/public/catalog`, `scripts/gen-catalog-art.py`); no third-party image host. Existing picsum rows are rewritten by `pnpm db:seed`.

## Phase 1 · Slice 3 — Ad Fuel wallet + Boost (Meta, connect your own) + Conversions API

**Ad Fuel** (admin → Ad Fuel; API `/api/fuel/*`). One wallet per organization (all stores share it).
- Top-up through Stripe Checkout (`POST /fuel/checkout`, card saved for auto-reload); credited by the
  `payment_intent.succeeded` webhook. Stub mode credits at once. The same `requestId` → the same
  PaymentIntent → credited once.
- Ledger: every row stores `balanceAfterCents`/`bonusAfterCents`. All money moves run under a row lock
  (`SELECT … FOR UPDATE`) and DB CHECKs keep balances ≥ 0.
- Spend/fee debits: one `AdChargeDay` per campaign per day. Re-syncs charge only the difference; a downward
  revision is credited back. Bonus fuel is spent first. When fuel can't cover a charge, the gap is recorded
  as a shortfall, the campaigns pause (`low_fuel`) and the merchant is notified. The next top-up settles it
  and resumes them.
- Auto-reload: single-flight claim per wallet, Stripe idempotency key `sf-autoreload-<wallet>-<seq>`,
  at most `ADS_AUTORELOAD_MAX_PER_DAY` per day. Three declines (or one `requires_action`) switch it off
  with an email. An unknown outcome is retried by the reconciler with the same key.
- Refunds: per top-up, within 90 days, never bonus fuel (existing `/fuel/refunds`).

**Boost** (admin → Boost; API `/api/boost/*`). Merchant connects their own Meta ad account:
1. *Continue with Facebook* → Facebook Login for Business (stub: `/boost/connect/stub`). The OAuth `state` is single-use and lasts 10 minutes.
2. Long-lived user token, AES-256-GCM encrypted (`ADS_TOKEN_KEY`), scopes checked.
3. Pick the ad account, Page and Pixel (+ optional Test Events code).
4. *Launch on Meta*: campaign → ad set → creative → ad, all created PAUSED, then activated. The launch is
   resumable and single-flight; a timed-out create is found again by its `[sf:<id>]` name tag, so
   there are no duplicate campaigns.
5. Hourly sync (`ADS_SYNC_MS`): insights → `AdInsightDaily` → fuel charges. Stages: Meta review → Warming up →
   Steady (≥50 purchases in 7 days) / Rejected. Expired tokens mark the connection and ask the merchant to reconnect.

Fees: on their own account Meta bills the merchant for spend; fuel only pays `ADS_OWNED_FEE_PCT` (default
0, per the blueprint's "0% or small flat fee"). Platform-managed ads (slice 4) pay spend + `ADS_FEE_PCT` (15).

**Conversions API**: when an order is paid, a server `Purchase` goes to the store's Pixel with
`event_id = order_<orderId>`. Email, name, city, state, zip, country and external_id are SHA-256 hashed (no phone is collected)
per Meta's rules; fbp, fbc, IP and UA are sent raw. The storefront banner asks for marketing-cookie consent:
without consent there is no Pixel, no _fbp/_fbc and no CAPI event (recorded as `skipped`). The thank-you page fires the browser
`Purchase` with the same event id, so Meta deduplicates. Retries back off (max 8 attempts, 7-day window).
The shopper IP comes from the storefront's trusted-proxy chain (`x-sf-client-ip`), never a client-sent XFF.

Stub Meta (no `META_APP_ID`/`META_APP_SECRET`, or `META_MODE=stub`): a stateful stand-in for the Graph API.
It covers OAuth, accounts, Pages, Pixels, objects, review/disapproval, time-based insights, CAPI and a Test Events view
(admin → Boost → Purchase tracking). Dev state lives in `apps/api/.stub-meta.json` (gitignored).

Go-live checklist (Meta):
- Business Manager with **business verification**.
- A **Business-type app** with Facebook Login for Business (configuration → `META_LOGIN_CONFIG_ID`) and Marketing API.
- **App Review, Advanced Access** for `ads_management`, `ads_read`, `business_management`, `pages_show_list`,
  `pages_read_engagement`. Needs a screencast of this flow, a privacy policy URL and a data-deletion callback/URL.
- Valid OAuth redirect URI: `{API_PUBLIC_URL}/api/boost/meta/callback`. App Domains include the admin domain.
- Env: `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID`, `META_GRAPH_VERSION` (v26.0; v23 expired 2026-06-09, v24 2026-10-06), `ADS_TOKEN_KEY`
  (`openssl rand -base64 32`), `API_PUBLIC_URL`, `ADMIN_URL`. Stripe live keys are needed for real top-ups.
  `META_BUSINESS_ID`/`META_SYSTEM_USER_TOKEN`/`META_CAPI_TOKEN` are for managed mode (slice 4).
- Test: set a Test Events code on the store, place an order, and check Events Manager → Test events: server
  and browser Purchase, deduplicated.

### Slice 3 handoff notes (QA round 3)
- **The Ad Fuel wallet is org-wide**, not per store: one balance for all of an organization's stores.
  Refunds and *Charged today* are org-wide too, and ledger rows name the **campaign** (e.g. "Rugged Lamp 26 ·
  Boost · Nov 11"), not the store. Per-store spend is on each store's Boost page.
- **Set `API_PUBLIC_URL` and `ADMIN_URL`** to the exact hosts the browser uses. The Meta `redirect_uri` is
  `{API_PUBLIC_URL}/api/boost/meta/callback`, and the callback sends the merchant on to `{ADMIN_URL}/boost`.
  If they are unset or use another host (127.0.0.1 vs localhost), the callback lands on the wrong host and
  the admin session cookie and CORS no longer match.
- **`TRUSTED_PROXIES` only applies when the storefront runs through `pnpm start` (= `node server.mjs`)**.
  That server stamps the real TCP peer for the middleware. `next start`/`next dev` have no peer stamp, so
  XFF is ignored and CAPI gets no client IP (safe, just less match quality).
- **`ADS_TOKEN_KEY` is required** unless `NODE_ENV=development|test`, and the API refuses to start without it.
  The dev fallback is derived from `BETTER_AUTH_SECRET`, so rotating that secret makes stored Meta tokens
  undecryptable and merchants must reconnect. Generate the key once (`openssl rand -base64 32`) and keep it with
  the other secrets. `pnpm dev` sets `NODE_ENV=development`.
- Crash between "paid" and the CAPI row: the order sweeper (every `ORDER_SWEEP_MS`) re-creates the Purchase for
  paid + consented orders up to ~7 days old, with the same `event_id` (still deduplicated) and the order time as `event_time`.
- Private-address checks (TLS probe, trusted proxies) canonicalise IPs first: IPv4-mapped (dotted or hex),
  expanded/compressed IPv6, NAT64/6to4/Teredo, non-canonical IPv4 (`127.1`, `0x7f…`) are all handled.

## Phase 1 · Slice 4 — Managed Boost (Meta managed, Google Ads Performance Max, TikTok)

Pick a product → StoreForge writes 4 copy variants, renders 4 crops (1:1, 4:5, 9:16, 1.91:1), checks
them against ad policy, and launches on the channels the merchant picks, in **StoreForge-owned** ad
accounts (one per store per channel). Fuel pays **spend + `ADS_FEE_PCT` (15%)**, charged hourly.

All three platforms run as **stubs** until keys exist (`GOOGLE_ADS_MODE`/`TIKTOK_MODE`/`META_MODE` blank
or `stub`). The stubs keep each platform's real request/response shapes (Google Ads REST `googleAds:search`
GAQL + atomic `googleAds:mutate` with temp resource names; Merchant API v1 sub-accounts, data sources,
`productInputs:insert`; TikTok Business API v1.3 `{code,message,request_id,data}` envelope; Graph v26.0)
over one delivery simulator that honours budgets, review, pauses and **account spend ceilings**.

| Where | What |
| --- | --- |
| `apps/api/src/ads/managed/` | `managed.service.ts` (provision, drafts, launch, sync, ceilings, fuel, ladder, reconcile), `adapters.ts` (one `ManagedChannel` per platform), `google/` `tiktok/` `metam/` (client interface + live + stub), `creative.service.ts`, `policy.service.ts`, `conversions.ts`, `config.ts`, `sim.ts` |
| API | `GET /api/boost/managed`, `POST …/enable`, `POST …/drafts`, `POST/GET …/groups/:id`, `…/launch`, `…/pause`, `…/resume`, `…/budget`, `POST …/sync`, `GET …/events`; public `GET /api/managed/render/:storeProductId/:ratio.png` |
| Admin | Boost → **Managed by StoreForge** tab (the slice-3 flow is the *Your own Meta account* tab) |
| Storefront | consent-gated Meta Pixel(s) + Google tag (AW-) + TikTok Pixel; `gclid`/`ttclid`/`_ttp` sent with checkout only with consent |

**Money safety**
- Charges: `chargeDay` deltas per campaign-day (idempotent, row-locked, fuel never < 0); fee = round(spend × 15%).
- Ceilings: each account has a platform-side lifetime limit = spent + its share of collectible fuel
  `floor((fuel − uncharged × 1.15) / 1.15)`: Meta `spend_cap`, Google account budget (`spending_limit_micros`),
  TikTok prepaid balance (BC `RECHARGE`/`DEDUCT`). Recomputed after every charge/top-up/launch/budget change
  under a per-account lease + dirty flag. **Meta's `spend_cap` is never 0** (0 = no cap) and has a platform
  minimum (`META_MIN_SPEND_CAP_CENTS`, $100): below it the hourly low-fuel pause is the backstop.
- Low fuel → every managed campaign on every channel pauses (one notice); top-up raises ceilings first, then resumes.
- Launch: needs one day of budget + 15% in fuel; group status CAS + per-campaign lease; every platform id is saved
  as soon as it exists and lost responses are found by their `[sf:<id>]` tag, so retries never duplicate.
- Reconcile (02:00 UTC): D-1…D-7 platform vs charged; any drift is charged/credited to the platform number
  (`AdReconcile`), > `ADS_RECONCILE_ALERT_BPS` (1%) alerts ops; account spend no campaign explains alerts critical.
- Conversions: one Purchase per channel (Meta CAPI on the managed Pixel, Google enhanced conversion
  **adjustment** keyed by order id with the hashed email only, TikTok Events API `CompletePayment`), each deduped
  with its browser tag by the same id; consent required; retried with backoff for up to 7 days.

### What Jeff needs to apply for (live keys)

**Google Ads (Performance Max + Merchant Center)**
1. **Google Ads manager account (MCC)** for StoreForge, with a **payments profile on monthly invoicing**
   (consolidated billing). Without invoicing, billing setups for client accounts can't be created by API and
   each client needs a card. → `GOOGLE_ADS_MCC_ID`, `GOOGLE_ADS_PAYMENTS_ACCOUNT_ID`.
2. **Google Cloud project** with the Google Ads API and Merchant API enabled. Since **2026-09-09 there are no
   developer tokens**: the access level belongs to the Cloud project that owns the OAuth client. Enabling gives
   *Test*; apply in Cloud Console → Google Ads API → Overview for **Explorer** (2,880 ops/day on production, usually
   automated). We need **Basic** (15,000 ops/day) to scale, and **account creation (`CreateCustomerClient`) and
   billing setup are not allowed at Explorer**, so Basic is required before the first live store. Standard
   (unlimited) later.
3. **OAuth consent screen: External, published, brand-verified** (Basic access requires it). Scopes
   `…/auth/adwords` + `…/auth/content` are sensitive, so they need Google's verification (privacy policy, homepage,
   domain ownership, demo video). → `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and a refresh token
   from the MCC admin user → `GOOGLE_ADS_REFRESH_TOKEN`.
4. **Merchant Center advanced (multi-client) account** linked to the MCC (request "advanced account" in MC
   settings); the Cloud project registered with `accounts.developerRegistration:registerGcp`. → `GOOGLE_MERCHANT_CENTER_ID`.
   Per store we create a sub-account, a primary API data source, and link it to the store's Ads client account.
   Each store's website must be **verified and claimed** in its sub-account before products serve. *Not built
   yet: confirm the live claim flow (HTML tag / file on our storefront host) when keys exist.* `approveAdsLink`
   in `google/live.ts` is the one Merchant API call marked VERIFY.
5. Policy: Google Ads **advertiser verification** for the MCC's payments profile; Shopping/PMax policies
   (landing pages must be https with price, shipping and returns).

**TikTok (Business API v1.3)**
1. **TikTok For Business developer account** + a **developer app** (portal → Create an App). The description must say
   it creates and manages ad accounts for StoreForge's merchants under our Business Center. Scopes: Ad Account
   Management, Ads Management, Reporting, **Business Center** (asset + advertiser + transfer), Pixel/Events,
   Catalog, Creative (image upload). Review takes 2–3 business days. → `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`.
2. **Business Center** (an agency/self-service-agency BC can create AUCTION advertisers via `/bc/advertiser/create/`;
   agency BCs need `qualification_info`). Fund it as a **prepaid** BC (we move balance into each advertiser with
   `/bc/transfer/`); per-BC creation quotas apply. → `TIKTOK_BC_ID`.
3. A BC **Admin** authorises the app → long-term access token. → `TIKTOK_ACCESS_TOKEN`.
4. Choose the industry id from `/tools/industry/get/` → `TIKTOK_INDUSTRY_ID` (current value is a placeholder).

**Meta (managed mode)**
1. StoreForge **Business Manager**, verified (Business Verification), with a credit line or card that ad
   accounts it creates can use, and a high enough ad-account creation limit. → `META_BUSINESS_ID`.
2. A Business-type app with Marketing API and **Full access** (formerly "Advanced") for `ads_management`,
   `business_management`, `ads_read` (App Review). → `META_APP_SECRET` (already used in slice 3).
3. An **Admin system user** in the BM with a never-expiring token for that app. → `META_SYSTEM_USER_TOKEN`.
4. The **StoreForge Facebook Page** managed ads run as. → `META_MANAGED_PAGE_ID`. *(Decision for Jeff: ads show as
   StoreForge's Page, not the merchant's. Using each merchant's Page needs Page access per store.)*

Once those exist, set the env vars (see `.env.example`), leave the `*_MODE` vars blank, restart the API, and run
one store end-to-end with a small budget on each channel before turning on `ADS_MANAGED_CHANNELS` for everyone.

## Phase 1 · Slice 5 — Product research + abandoned-bag recovery

**Research** (admin → Research, API `/api/research/*`)
- Every catalog product gets a `ProductScore` (0–100): **trend 35%** (search interest 65% + StoreForge
  order velocity over 14 days 35%), **margin 30%** (net margin after card fees, ad cost (CPA) and ad fee, 0–35% → 0–100),
  **room 20%** (100 − ad saturation from the Meta Ad Library), **shipping 15%** (ETA). Refreshed when older than
  `RESEARCH_TTL_HOURS` (24); "Refresh" re-scores up to 100 products, 4 at a time (30 s throttle per account).
- Sources: `SERPAPI_API_KEY` → Google Trends via SerpApi; `META_AD_LIBRARY_TOKEN` → Ad Library active-ad counts
  (the API only covers EU/UK for non-political ads, so saturation is an EU/UK proxy). Without keys both run as
  deterministic **sample data**, and the page and every draft say so.
- Insight + 3 ad angles from `LLM_API_KEY` (OpenAI-compatible; `LLM_BASE_URL`, `LLM_MODEL`). Model output is
  treated as untrusted text, capped and run through the ad policy scanner; blocked angles are dropped. No key →
  template drafts, no network call.
- Margin calculator (shared `marginCalc`, also `POST /api/research/margin`): price, cost, supplier shipping,
  Stripe 2.9% + 30¢, `PLATFORM_FEE_BPS` (0), ad CPA and the Boost fee, 3% refund reserve → profit per order,
  margin, break-even CPA/ROAS. "Add to store" imports at the chosen markup.

**Abandoned-bag recovery** (storefront bag drawer, admin → Recovery, outbox kinds `CART_REMINDER_1/2`)
- Opt-in only: an **unticked** box in the bag ("Email me a reminder about this bag…"). Nothing is stored without
  it; the exact wording and time are kept as consent evidence. Unticking scrubs the email.
- Two reminders at most: `CART_REMINDER_1_MINUTES` (60) after the last activity and `CART_REMINDER_2_HOURS` (24),
  at least 12 h apart; no first reminder after 72 h; one sequence per address per shop per week; bags expire after
  `CART_EXPIRE_DAYS` (7) and the email/name are deleted (also on purchase and unsubscribe).
- Idempotent: the sweeper (`CART_SWEEP_MS`, 60 s) claims `reminderNAt` and writes the outbox row (dedupe key
  `CART_REMINDER_N:<cartId>`) in one transaction, so concurrent sweepers or retries send once. At send time the
  outbox re-checks purchase, consent, suppression and the store setting, and cancels the email (`CANCELLED`) if any fail.
- Compliance: every reminder has the store's **mailing address** (required to turn reminders on; CAN-SPAM/CASL),
  `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058 one-click), and a signed unsubscribe page where GET only
  shows a button (link scanners can't unsubscribe anyone). Unsubscribes are per shop and permanent. Order emails are
  transactional and unaffected. No fake urgency or discounts in the copy.
- Recovered revenue counts only orders paid after a reminder was **sent** on that bag.
- Signed links use `EMAIL_LINK_SECRET` (≥ 32 chars). **Required in production**; the API refuses to start without it.
- e2e: the reminder step backdates a bag with local `psql` and waits for the sweeper, so start the API with
  `CART_SWEEP_MS=3000` (skipped if psql isn't available).

### Keys for slice 5
| Purpose | Env | Notes |
|---|---|---|
| Copy drafts | `LLM_API_KEY` (+ `LLM_BASE_URL`, `LLM_MODEL`) | Any OpenAI-compatible endpoint; `OPENAI_API_KEY` also works |
| Search trends | `SERPAPI_API_KEY` | Paid SerpApi plan (Google has no public Trends API; the Trends API alpha is invite-only) |
| Ad saturation | `META_AD_LIBRARY_TOKEN` | User token from a Meta app with Ad Library API access; the account must finish identity verification |
| Signed email links | `EMAIL_LINK_SECRET` | `openssl rand -base64 32` |
| Sending | `RESEND_API_KEY` + verified sending domain | From slice 2; reminders stay in the outbox/dev transport without it |
| Per store | Mailing address | Entered by each merchant on the Recovery page |

## Dependency audit (`pnpm audit --prod`)

QA round 1 found 42 (21 high, 2 critical). Fixed by upgrades: `next` ^15.5.29 (Image Optimizer RCE; admin + storefront, and the Image Optimization API is disabled with `images.unoptimized` and no `remotePatterns`), `better-auth` ^1.7.22, `zod` ^4.6.6. Transitive fixes are version-scoped `pnpm.overrides` in the root `package.json` (each only rewrites versions below the patched one): `sharp` ≥0.35.5, `multer` ≥2.1.0, `body-parser` ≥1.20.6, `qs` ≥6.15.2, `js-yaml` 4.x ≥4.1.1, `lodash` ≥4.18.0, `postcss` ≥8.5.10, `source-map-js` ≥1.2.2, `deepmerge-ts` ≥8, `file-type` ≥21.3.1, `zod` 4.x ≥4.6.6.

Remaining (accepted, 1 moderate):

| Package | Advisory | Why it stays |
| --- | --- | --- |
| `@nestjs/core` 10.4.x | GHSA-36xv-jgw5-4q75, SSE event injection (fixed in 11.1.18) | Only affects `@Sse()` endpoints that put user data in the event `type`/`id`. StoreForge has no SSE endpoints (`grep -r "@Sse" apps/api/src` is empty). The fix needs the NestJS 11 / Express 5 major upgrade, which is planned as its own change rather than mixed into a QA fix. |
