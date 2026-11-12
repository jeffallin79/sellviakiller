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

1. Admin http://localhost:3001/signup — create merchant
2. Billing → Subscribe **Starter $29** (stub activates without `STRIPE_SECRET_KEY`)
3. Stores → create slug `demo`
4. Catalog → select products → **1-click import**
5. Storefront http://localhost:3000/s/demo → add to cart → checkout (stub marks PAID)
6. Admin Orders → Approve fulfillment → CJ stub returns tracking
7. Export CSV: `/api/export/products.csv` and `/api/export/orders.csv`

Soft-delete stores from Stores page — **never hard-deletes** on cancel.

## Blockers / secrets

| Env | Required for | Without it |
| --- | --- | --- |
| `DATABASE_URL` / `REDIS_URL` | Boot | Apps won't persist / jobs inline |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER/GROWTH/SCALE` | Stripe Billing, Connect checkout, Ad Fuel, webhooks | **Stub mode** — local ACTIVE sub, instant payout account, instant PAID checkout, instant fuel credit |
| `CJ_API_KEY` (+ email/password) | Live CJ catalog sync / fulfill | **Fixtures** via `pnpm db:seed` (`USE_CATALOG_FIXTURES=true`). Spocket/Zendrop stay stubs. |
| `BETTER_AUTH_SECRET` | Auth cookies | Dev default (change before deploy) |

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
