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

## Dependency audit (`pnpm audit --prod`)

QA round 1 found 42 (21 high, 2 critical). Fixed by upgrades: `next` ^15.5.29 (Image Optimizer RCE; admin + storefront, and the Image Optimization API is disabled with `images.unoptimized` and no `remotePatterns`), `better-auth` ^1.7.22, `zod` ^4.6.6. Transitive fixes are version-scoped `pnpm.overrides` in the root `package.json` (each only rewrites versions below the patched one): `sharp` ≥0.35.5, `multer` ≥2.1.0, `body-parser` ≥1.20.6, `qs` ≥6.15.2, `js-yaml` 4.x ≥4.1.1, `lodash` ≥4.18.0, `postcss` ≥8.5.10, `source-map-js` ≥1.2.2, `deepmerge-ts` ≥8, `file-type` ≥21.3.1, `zod` 4.x ≥4.6.6.

Remaining (accepted, 1 moderate):

| Package | Advisory | Why it stays |
| --- | --- | --- |
| `@nestjs/core` 10.4.x | GHSA-36xv-jgw5-4q75, SSE event injection (fixed in 11.1.18) | Only affects `@Sse()` endpoints that put user data in the event `type`/`id`. StoreForge has no SSE endpoints (`grep -r "@Sse" apps/api/src` is empty). The fix needs the NestJS 11 / Express 5 major upgrade, which is planned as its own change rather than mixed into a QA fix. |
