# StoreForge — Phase 1 Blueprint (2026-11-02)
Base: Phase 0 @ e754135 (QA APPROVE). Locked stack unchanged: Next.js (admin + storefront + marketing), NestJS API, Postgres/Prisma, Redis/BullMQ, Better Auth, **Stripe (switched from Square on 2026-11-12 per Jeff)**, CJ adapter first. No weekly performance tiers.

## 1. Scope
Research scores + margin calc · custom domains · abandoned-cart + order emails · new theme system · multi-supplier routing (CJ + Spocket/Zendrop) · ad copy/creative drafts · Academy · digital products · **"Boost" ads module (functional parity with Sellvia ADS)** · full rebrand ("Garnet & Saffron") that looks nothing like Sellvia.

## 2. Sellvia ADS — what we are matching (research)
Sources: help.sellvia.com/en/articles/13395359 (Sellvia Ads), /13842087 and /15221530 (Fees), sellvia.com/terms-of-use, ecomreality.com/sellvia-ads-budgeting-store-profit.
- **Fully managed**: Sellvia selects products, creates campaigns, targets, optimizes; merchant never touches ad accounts (runs in Sellvia's accounts). Channels claimed: Google Shopping, Meta (FB/IG feeds, Stories, Marketplace), TikTok, Amazon.
- **Budget**: min $10/day; auto-step-ups by cumulative spend ($140→$15, $280→$20, $560→$30, $1,680→$50/day); merchant can lower, not raise manually. Charged daily; failed payment pauses ads, retried 4 days.
- **Ads Credits**: prepaid, non-withdrawable, only usable for promotion. **28% service fee** applied on credits consumed by delivery (20 credits spent → 25.60 deducted). Commission payouts into Ads Credits incur 5%.
- **Lifecycle shown to merchant**: "Learning" stage (unstable) → "Performance" stage. Opt-out = run ads yourself.
- Promo $40 coupon: not confirmed in official docs found this pass — treat as marketing promo; we model a configurable `first_fuel_bonus` instead.
- Ad spend not included in Sellvia's profit calc → we include it (differentiator).

## 3. Ads module ("Boost") architecture
**Recommendation: hybrid.** Default = *Managed* (campaigns run in StoreForge-owned Meta Business Manager ad accounts / Google Ads MCC sub-accounts / TikTok Business Center advertiser accounts, one per merchant, funded by platform card). Pro option = *Connect your own* (OAuth merchant account, 0% management fee or small flat fee). Managed matches Sellvia UX; own-account gives data ownership (anti-Sellvia message).
Tradeoffs: managed = StoreForge carries spend float, chargeback & policy risk (one bad merchant can get BM restricted → isolate per-merchant ad accounts, credit limits, pre-launch policy checks). Own-account = no float risk, slower onboarding, merchant needs own billing.

**Merchant flow**: pick product → AI drafts 3–5 copy variants + creatives (product images resized 1:1/4:5/9:16, optional UGC-style video template) → pick channels + daily budget (min $10, step-up ladder like Sellvia but merchant MAY raise manually) → policy check → launch → "Warming up" → "Steady" states → live dashboard.

**Ad Fuel wallet (credits)**: top-up via Stripe (PaymentIntents + saved PaymentMethod, Stripe Elements / Checkout); auto-reload threshold. Daily job debits `spend + fee`. Fee % configurable per plan (`ADS_FEE_PCT`, default 15% — undercut 28%). Unused fuel refundable to card within 90 days minus processor costs (Sellvia: non-withdrawable → our differentiator); promo/bonus fuel non-refundable.

**Data models (Prisma)**: `AdAccount(id, storeId, channel[META|GOOGLE|TIKTOK], mode[MANAGED|OWNED], externalId, status, tokenRef)`, `AdCampaign(id, storeId, productId, channel, externalId, dailyBudgetCents, stage[DRAFT|REVIEW|WARMING|STEADY|PAUSED|REJECTED], ladderStep)`, `AdCreative(id, campaignId, type, assetUrl, headline, body, policyStatus)`, `AdWallet(storeId, balanceCents, bonusCents, autoReloadCents, thresholdCents)`, `WalletTxn(id, walletId, kind[TOPUP|SPEND|FEE|REFUND|BONUS|ADJUST], amountCents, stripePaymentIntentId?, campaignId?, day)`, `AdInsightDaily(campaignId, date, impressions, clicks, spendCents, purchases, revenueCents)`, `ConversionEvent(id, storeId, orderId, eventName, eventId, sentMeta, sentGoogle, sentTikTok)`, `PolicyCheck(id, creativeId, rules[], result)`.
**Queues (BullMQ)**: `ads.launch`, `ads.sync-insights` (hourly), `ads.reconcile` (daily 02:00 UTC: platform-reported spend vs wallet debits; >1% drift → alert + adjust txn), `ads.wallet-debit`, `ads.budget-ladder`, `ads.low-fuel` (pause at 0, email), `capi.dispatch` (retry w/ dedupe by eventId), `ads.policy-scan`.
**Services**: `AdsService` (orchestrates), channel adapters `MetaAdsAdapter` (Marketing API: campaign/adset/ad, Advantage+ shopping), `GoogleAdsAdapter` (Performance Max + Merchant Center product feed via Content API), `TikTokAdsAdapter` (Marketing API, Smart+ / product shopping), `CreativeService`, `WalletService` (Stripe), `PolicyService` (prohibited-category list, claims regex, image text checks, plus platform review result), `ConversionService`.
**Pixel/conversions**: storefront loads Meta Pixel, gtag, TikTok Pixel per store; server-side Meta CAPI, Google Ads enhanced conversions (hashed email/phone, gclid), TikTok Events API from order-paid webhook (Stripe `payment_intent.succeeded` / `checkout.session.completed`). Shared `event_id` for browser/server dedupe. Cookie consent banner gates pixels.
**Reporting**: dashboard shows spend, fee, ROAS, CPA, and **true profit = revenue − COGS − shipping − spend − fee**.

**Approvals/timelines (start now — longest pole)**:
- Meta: Business Manager + business verification (days–2 wks); app with `ads_management`, `business_management` Advanced Access via App Review (~2–6 wks); system-user tokens; credit line/prepaid funding for managed accounts.
- Google Ads: MCC + developer token — Test → **Basic access** application (~1–3 wks, 15k ops/day) → Standard later; OAuth consent screen verification; Merchant Center multi-client account.
- TikTok: TikTok for Business developer app approval (~1–3 wks), Business Center, Marketing API scopes.
- Legal: reseller/agency ToS, credits/refund terms, money-transmission review of wallet (keep it as prepaid service credit, not stored value).

## 4. Other Phase 1 modules (brief)
- **Research**: `ProductScore` (trend 0–100 from order velocity + Google Trends, margin, saturation from ad library counts, shipping ETA) + margin calculator incl. ad cost.
- **Custom domains**: `Domain(storeId, host, status, verifiedAt)`; TXT/CNAME verification, TLS via Caddy on-demand or Vercel Domains API.
- **Email** (Resend/Postmark): order confirm/shipped/delivered, abandoned cart (1h, 24h), queue `email.send`.
- **Themes**: 3 storefront themes on shared tokens.
- **Multi-supplier routing**: `SupplierAdapter` interface; rule: in-stock → cheapest landed cost → fastest ETA.
- **Digital products**: `Product.kind=DIGITAL`, signed R2 download links, no fulfillment job.
- **Academy**: MDX lessons in admin, progress table.

## 5. Slice order (income first)
1. **Brand/theme tokens** (`packages/ui`) + admin/storefront reskin — everything after builds on it. AC: no hard-coded colors; light/dark toggle; AA verified.
2. **Custom domains + order emails** — AC: domain verified with TLS <10 min; order emails sent for paid/shipped.
3. **Ad Fuel wallet (Stripe) + own-account Meta connect + CAPI** — first ad revenue path while managed approvals pend. AC: top-up, debit, refund, CAPI events dedup'd in Meta test events.
4. **Boost managed — Meta**, then **Google PMax + feed**, then **TikTok**. AC: pick→launch <3 min; hourly insights; reconcile drift <1%; low-fuel pause.
5. **Abandoned cart + research scores/margin calc.**
6. **Multi-supplier routing + digital products.**
7. **Theme pack 2–3 + Academy.**

## 6. Brand system — "Garnet & Saffron"
| Token | Hex | Use |
|---|---|---|
| `--sf-primary` garnet-600 | #A3153F | buttons, links (light) |
| `--sf-primary-dark` garnet-400 | #F06A8E | primary on dark |
| `--sf-accent` saffron-400 | #F5B32E | highlights, badges, KPIs up |
| `--sf-accent-ink` saffron-700 | #8A5A00 | accent text on light |
| `--sf-secondary` lagoon-700 | #1F5F66 | charts, secondary actions |
| `--sf-secondary-dark` lagoon-300 | #7FC4C8 | secondary on dark |
| `--sf-bg` paper-50 | #FBF6F0 | light bg (warm paper) |
| `--sf-border` sand-200 | #E8DCCD | light borders |
| `--sf-text` ink-700 | #2B1E27 | light text |
| `--sf-bg-dark` ink-900 | #1C1219 | dark bg (plum-black) |
| `--sf-surface-dark` ink-800 | #2A1D26 | dark cards |
| `--sf-text-dark` mist-100 | #F3E9EE | dark text |
| success / warning / danger / info | #2E7D4F / #965A00 / #B3261E / #3559A8 | semantic |
Contrast (WCAG): text/paper 14.8, mist/ink 15.4, white/garnet 7.7, garnet/paper 7.1, ink/saffron 9.9, garnet-400/ink 6.2, lagoon-300/ink-800 8.2, white/lagoon 7.3, saffron-700/paper 5.5, white on success 5.1 / warning ≥4.5 / danger 6.5 / info 6.7 — all AA. (`brand/contrast.txt`)
Balance rule: marketing site + storefront hero alternate paper and ink bands 50/50; admin = light content, ink sidebar; full dark mode.
Fonts (Google): **Bricolage Grotesque** (display), **Instrument Sans** (UI/body), **JetBrains Mono** (numbers/IDs).
Look & feel: warm editorial "market hall" — paper bg, plum-ink bands, garnet calls to action, saffron as the "money" signal, chunky 14–18px radii, thick 2px outlines, tabular numbers.
Competitor hues avoided (approximate public brand hexes, verify before trademark filing): Shopify green #95BF47/#008060; Sellvia bright blue/violet gradients (~#3A5BFF range); Spocket purple/violet; AutoDS blue; Zendrop blue/indigo; CJdropshipping orange (~#F26B21); DSers blue (~#1A73E8 range); Wix black + blue #116DFF; BigCommerce near-black navy #121118 + blue; Squarespace monochrome black/white; WooCommerce purple #7F54B3/#720EEC. None use garnet + saffron + plum-ink; nearest risk is Woo purple → our ink is near-black plum, used as neutral, not as brand hue.
Package: `packages/ui/tokens.css` (CSS vars `:root` + `[data-theme=dark]`), `tailwind.preset.ts` mapping `colors.primary = 'rgb(var(--sf-primary) / <alpha-value>)'` etc.; ESLint rule banning raw hex in apps.

## 7. "Look nothing like Sellvia" rules
- **Colors**: no blue/violet primaries or gradients anywhere.
- **Layout**: no Sellvia-style left-nav + big blue hero banners; admin uses ink rail + "Launchpad" home with task cards; storefront themes editorial grid, not WP/WooCommerce templates.
- **Naming**: Ads = "Boost", credits = "Ad Fuel", learning/performance = "Warming up/Steady", dashboard = "Launchpad", catalog = "Shelf", order processing = "Dispatch". Never use "Sellvia", "Performance Tier", "Ads Credits", "Order Processing Credits".
- **Copy**: plain, honest; show real ETAs and all fees inline; no "1 billion customers", no guaranteed income claims, no countdown upsells.
- **Iconography**: Phosphor icons (duotone, garnet/saffron), not Sellvia-style flat blue icons; illustrations = hand-cut paper/collage style.
- **Pricing UX**: one pricing page, monthly tiers, fee % stated on Boost screen.
- No Sellvia screenshots, assets, or text reused (also legal hygiene).

## 8. Env vars / keys Jeff must obtain
`STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_CONNECT_CLIENT_ID, STRIPE_PRICE_STARTER/GROWTH/SCALE` · `CJ_API_KEY` · `SPOCKET_API_KEY`/`ZENDROP_API_KEY` · `META_APP_ID, META_APP_SECRET, META_BUSINESS_ID, META_SYSTEM_USER_TOKEN, META_CAPI_TOKEN` · `GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_MCC_ID, GOOGLE_OAUTH_CLIENT_ID/SECRET, GOOGLE_MERCHANT_CENTER_ID` · `TIKTOK_APP_ID, TIKTOK_APP_SECRET, TIKTOK_BC_ID, TIKTOK_EVENTS_TOKEN` · `RESEND_API_KEY` · `R2_*` · `OPENAI/LLM_API_KEY` (copy drafts) · `DOMAIN_PROVIDER_TOKEN` · `ADS_FEE_PCT, ADS_MIN_DAILY_CENTS`.

## 9. Risks
Ad platform approval delays (mitigate: ship own-account mode first) · BM restriction from one merchant's bad ads (per-merchant accounts, policy scan, credit caps) · spend float/chargebacks on wallet (prepay only, Stripe Radar + dispute handling) · wallet regulatory classification · creative IP (only merchant/supplier-licensed images) · trademark collision on name/palette (search before launch) · data privacy for CAPI (consent, hashing).

## Payments switch (2026-11-12): Square -> Stripe
Jeff switched StoreForge to **Stripe**. Do this as build-order step 0, before or alongside the reskin:
- **SaaS billing**: Stripe Billing (Products/Prices for $29/$79/$199, Customer Portal, `customer.subscription.*` + `invoice.*` webhooks). No weekly performance tiers.
- **Storefront checkout**: Stripe Connect, Express accounts, one per merchant (Connect onboarding in Launchpad). Destination charges via Checkout/PaymentIntents with `application_fee_amount` if a platform fee is enabled (default 0 on subscription plans). Payouts go straight to merchants.
- **Ad Fuel**: platform-account PaymentIntents with saved card for auto-reload; refunds via Stripe Refunds.
- Remove the Square adapter, Square env vars and the Square webhook route; keep a `PaymentProvider` interface and a stub mode until keys exist.
- Webhooks: verify with `STRIPE_WEBHOOK_SECRET` (platform) and a Connect webhook endpoint; idempotent handlers keyed on event id.
- Migrate the Phase 0 order/payment columns (`squarePaymentId` etc.) to provider-neutral `providerPaymentId` + `provider`.
- AC: test-mode signup -> subscription active; merchant Connect onboarding -> live test order -> payout to the connected account; Ad Fuel top-up + refund; webhooks replay-safe.

## Later add-on (not Phase 1): crypto checkout
Optional BTC payment method via BTCPay Server (self-hosted, no processing fees) or Coinbase Commerce, added only when merchants ask. Stripe stays the primary processor for all billing, checkout, and Ad Fuel top-ups.
