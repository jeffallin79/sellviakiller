# StoreForge — Phase 0 MVP

Turnkey multi-tenant dropshipping ecommerce (Sellvia competitor).  
**Payments: Square only** (no Stripe).

Authoritative brief: [`BUILDER_HANDOFF.md`](./BUILDER_HANDOFF.md).

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
| Payments | Square Checkout + SaaS subscriptions |

## Quick start

```bash
# 1) Infra
cp .env.example .env
docker compose up -d          # Postgres :5432 + Redis :6379

# 2) Install
pnpm install

# 3) DB
pnpm db:generate
pnpm db:push                  # or: pnpm db:migrate
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
2. Billing → Subscribe **Starter $29** (stub activates without `SQUARE_*`)
3. Stores → create slug `demo`
4. Catalog → select products → **1-click import**
5. Storefront http://localhost:3000/s/demo → add to cart → Pay with Square (stub marks PAID)
6. Admin Orders → Approve fulfillment → CJ stub returns tracking
7. Export CSV: `/api/export/products.csv` and `/api/export/orders.csv`

Soft-delete stores from Stores page — **never hard-deletes** on cancel.

## Blockers / secrets

| Env | Required for | Without it |
| --- | --- | --- |
| `DATABASE_URL` / `REDIS_URL` | Boot | Apps won't persist / jobs inline |
| `SQUARE_ACCESS_TOKEN`, `SQUARE_APPLICATION_ID`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_PLAN_*_ID` | Live SaaS sub + checkout + webhooks | **Stub mode** — local ACTIVE sub + instant PAID checkout |
| `CJ_API_KEY` (+ email/password) | Live CJ catalog sync / fulfill | **Fixtures** via `pnpm db:seed` (`USE_CATALOG_FIXTURES=true`). Spocket/Zendrop stay stubs. |
| `BETTER_AUTH_SECRET` | Auth cookies | Dev default (change before deploy) |

Set `USE_CATALOG_FIXTURES=false` and `CJ_API_KEY=…` when Jeff provides CJ credentials.

## Phase 0 acceptance

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Merchant sign up / sign in | Works (Better Auth) |
| 2 | Subscribe via Square Starter | Stub OK / live when keys set + webhook `/api/webhooks/square` |
| 3 | Provision one store `{slug}.storeforge.local` | Works |
| 4 | Seed 200–500 SKUs | Fixtures (~300); CJ live when keyed |
| 5 | 1-click import catalog → store | Works |
| 6 | Customer Square checkout | Stub OK / Payment Links when keyed |
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
```

## License

Private — StoreForge Phase 0 scaffold.


## Domain note

Merchant tenant model is named **Organization** in Prisma (Better Auth reserves `Account` for credential/OAuth links). Admin API still returns `memberships[].account` for UI compatibility.

## Verified on this box (2026-09-18)

Without Docker/Redis/`SQUARE_*`/`CJ_*`:
- Embedded Postgres via `.local-bin/pgsql` + `scripts/start-local-postgres.sh`
- BullMQ falls back to **inline** jobs when Redis is down
- Full path: signup → Square stub subscribe → provision `demo` → import 5 SKUs → checkout (PAID stub) → approve → CJ stub tracking `SHIPPED`

Prefer `docker compose up -d` on Jeff's machine for Postgres+Redis.

