# StoreForge — Builder Handoff (APPROVED)

**From:** Software Engineer  
**For:** Builder  
**Status:** Jeff locked own-storefront blueprint — implement Phase 0 MVP  
**Working name:** StoreForge (rename later if Jeff picks another)  
**Payment change (2026-09-18):** Jeff mandated **Square, not Stripe**. Do not implement Stripe.

## Goal
Full-stack Sellvia competitor: turnkey multi-tenant ecommerce for dropshippers/digital sellers. Beat Sellvia on clear pricing, modern stack (not WordPress lock-in), honest fulfillment ETAs, exportable merchant data, and research baked into the dashboard.

## Non-goals (Phase 0)
- Own warehouse / 3PL
- Managed ads agency desk
- Store marketplace (buy/sell stores)
- High-ticket one-time packages
- Weekly "performance tier" billing
- Shopify-first (Shopify connector is Phase 2+)

## Monetization (implement billing hooks now)
- Starter ~$29/mo — 1 store, catalog, basic research, ~100 orders/mo
- Growth ~$79/mo — 3 stores, email tools, ads drafts later, higher limits
- Scale ~$199/mo — multi-store, priority routing, API later
- Optional small Square application fee / platform fee on checkout
- **No weekly performance tiers**

## Stack (locked)
| Layer | Choice |
| --- | --- |
| Storefront + merchant admin | Next.js (App Router), TypeScript |
| API | NestJS **or** Fastify + OpenAPI (pick one; prefer NestJS if you want module boundaries) |
| DB | Postgres + Prisma or Drizzle |
| Jobs | Redis + BullMQ |
| Auth | Clerk or Better Auth |
| Payments | **Square** (Checkout / Payment Links + Square subscriptions for SaaS; Square for Platforms / OAuth for merchant payouts as needed) |
| Email | Resend or Postmark |
| Media | Cloudflare R2 or S3 |
| Hosting | Vercel (apps) + Railway/Fly (API + workers) — or all on Fly |
| Catalog seed | CJ Dropshipping API first (Spocket/Zendrop adapters stubbed) |

## Architecture
```
Merchant browser
  → Next.js storefront (subdomain + custom domain later)
  → Next.js admin (merchant dashboard)
  → API
       → Postgres (tenants, stores, catalog, orders, billing)
       → Redis + BullMQ (sync, fulfill, email, webhooks)
       → Square (Checkout + SaaS subscriptions + merchant payments)
       → Supplier adapter interface → CJ impl first
```

**Tenancy:** Account → N Stores. Soft-delete stores. On cancel: keep data exportable; do **not** hard-delete merchant storefront data after 7 days (Sellvia pain point).

## Phase 0 MVP — ship runnable first
Acceptance criteria:
1. Merchant can sign up / sign in
2. Merchant can subscribe via Square (at least Starter price placeholder)
3. Platform provisions **one** store (subdomain like `{slug}.storeforge.local` / staging domain)
4. Seed catalog: import/sync **200–500** SKUs via CJ (or realistic fixtures if CJ keys missing — flag blocker)
5. 1-click product import from catalog → store
6. Customer can checkout on storefront via Square
7. Order appears in merchant admin
8. Fulfillment path: manual approve **or** auto if rules pass → job pushes to supplier adapter (CJ) → store tracking when webhook/poll returns
9. Basic order list + status + tracking display
10. README with run instructions (docker-compose for Postgres/Redis preferred)

### Suggested repo layout
```
/apps/storefront   — customer-facing Next.js
/apps/admin        — merchant dashboard Next.js
/apps/api          — NestJS/Fastify
/packages/db       — schema + migrations
/packages/shared   — types, zod schemas
/docker-compose.yml
```
Monorepo (pnpm/turborepo) preferred.

### Core domain models
- User, Account (org)
- Store (slug, theme, domain, status)
- Product (platform catalog) + StoreProduct (merchant listing, price override)
- Supplier, SupplierProductMapping
- Order, OrderLine, Fulfillment, TrackingEvent
- Subscription / Plan
- DepositBalance (optional for auto-fulfill prepaid wholesale — can stub)

### Supplier adapter interface
```ts
interface SupplierAdapter {
  id: string
  syncCatalog(cursor?: string): Promise<CatalogPage>
  createFulfillment(order: NormalizedOrder): Promise<{ externalId: string }>
  getTracking(externalId: string): Promise<TrackingInfo>
}
```
Implement `CjAdapter`; stub `SpocketAdapter` / `ZendropAdapter`.

### Order flow (Phase 0)
1. Square payment webhook → create Order (Paid)
2. Enqueue `route-fulfillment`
3. If auto-fulfill enabled + margin/deposit rules OK → adapter.createFulfillment
4. Else status = AwaitingMerchantApproval
5. Poll/webhook → update tracking → email customer (transactional)

## Phase 1+ (do not build yet unless Phase 0 done)
- Research scores / margin calculator
- Abandoned cart + marketing email
- Custom domains
- Better themes
- Multi-supplier routing
- Ads campaign drafts
- Academy CMS
- Digital products
- Store marketplace + US 3PL

## Product / legal stance (implement in copy + ToS placeholders)
- Honest ETAs from supplier data — no fake “US warehouse ships in 1–3 days” unless true for that SKU
- Clear sourcing labels on catalog items
- Export CSV for products/orders; theme export later

## Env / secrets Jeff will need
- DATABASE_URL, REDIS_URL
- SQUARE_ACCESS_TOKEN, SQUARE_APPLICATION_ID, SQUARE_LOCATION_ID, SQUARE_WEBHOOK_SIGNATURE_KEY, Square plan/catalog IDs for SaaS
- CJ API credentials (request from Jeff when ready)
- AUTH provider keys
- RESEND_API_KEY
- R2/S3 credentials

## Success report back to Jeff + Software Engineer
When Phase 0 is runnable locally (or deployed staging):
- What works
- What’s stubbed
- Blockers (esp. missing API keys)
- Next recommended slice

When feature-complete enough for volunteer human testing → hand to QA (id: b7e9b096-7c7d-45c9-9819-0ae9f20826b1). Do not self-declare ready-for-testers.

## Do not
- Redesign architecture without Software Engineer / Jeff
- Spin up new helper agents (ask Chief of Staff if needed)
- Moralize about dropshipping — ship the product
