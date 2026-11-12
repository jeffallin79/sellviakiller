import { createHash } from 'node:crypto';
import { getGoogleClient, googleLiveConfigured, type GoogleAdsClient, type MerchantClient, type MutateOperation } from './google';
import { getTikTokClient, tiktokLiveConfigured, fromMajor, toMajor, type TikTokClient } from './tiktok';
import { getMetaGraph, metaManagedLiveConfigured, type MetaGraph } from './metam';
import { PlatformError, fromMicros, toMicros, type AccountRef, type BrowserTag, type Channel, type DeliveryStatus, type FeedProduct, type FeedResult, type InsightRow, type LaunchInput, type ManagedChannel, type ProvisionResult, type Refs, type ServerConversion } from './types';

const tagOf = (key: string) => `[sf:${key}]`;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const env = (k: string, d = '') => process.env[k] ?? d;
/** Numeric idempotency key for TikTok's request_id (string of digits) */
const numericKey = (s: string) => BigInt(`0x${createHash('sha256').update(s).digest('hex').slice(0, 15)}`).toString();
const ymdHms = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');

// =============================================================================================
// Google Ads (Performance Max for retail) + Merchant Center (Merchant API)
// =============================================================================================
export class GoogleChannel implements ManagedChannel {
  readonly channel = 'GOOGLE' as const;
  constructor(
    private readonly c: GoogleAdsClient & MerchantClient = getGoogleClient(),
    private readonly cfg = {
      mcc: env('GOOGLE_ADS_MCC_ID', '1234567890').replace(/-/g, ''),
      merchantAdvanced: env('GOOGLE_MERCHANT_CENTER_ID', '5000000001'),
      paymentsAccount: env('GOOGLE_ADS_PAYMENTS_ACCOUNT_ID', '0000-0000-0000-0000'),
    },
    /** PMax image assets are bytes (ImageAsset.data). Live: fetched from our render endpoint. */
    private readonly loadImage: (url: string) => Promise<Buffer> = async (url) => {
      if (this.c.mode === 'stub') return Buffer.from(`stub-image-bytes:${url}`);
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new PlatformError(`Could not load creative image (${r.status})`, 'GOOGLE', { status: 0, transient: true });
      return Buffer.from(await r.arrayBuffer());
    },
  ) {}
  get mode() { return this.c.mode; }
  get configured() { return this.c.mode === 'stub' || googleLiveConfigured(); }

  async provision(o: Parameters<ManagedChannel['provision']>[0], prev: Partial<AccountRef>, save: (p: Partial<AccountRef>) => Promise<void>): Promise<ProvisionResult> {
    const tag = tagOf(o.key);
    const r: Partial<AccountRef> = { ...prev };
    if (!r.externalId) {
      const found = await this.c.search(this.cfg.mcc, `SELECT customer_client.id, customer_client.descriptive_name FROM customer_client WHERE customer_client.level = 1 AND customer_client.descriptive_name LIKE '%${tag}%'`);
      r.externalId = found[0]?.customerClient?.id ?? (await this.c.createCustomerClient(this.cfg.mcc, { descriptiveName: `${clip(o.storeName, 60)} ${tag}`, currencyCode: o.currency, timeZone: o.timezone })).resourceName.split('/')[1];
      await save({ externalId: r.externalId });
    }
    const cid = r.externalId!;
    if (!r.merchantCenterId) {
      const subs = await this.c.listSubAccounts(this.cfg.merchantAdvanced);
      r.merchantCenterId = subs.find((s) => s.accountName.includes(tag))?.accountId ?? (await this.c.createSubAccount(this.cfg.merchantAdvanced, { accountName: `${clip(o.storeName, 60)} ${tag}`, timeZone: o.timezone, languageCode: 'en', websiteUrl: o.siteUrl })).accountId;
      await save({ merchantCenterId: r.merchantCenterId });
    }
    if (!r.dataSourceId) {
      r.dataSourceId = (await this.c.createDataSource(r.merchantCenterId!, { displayName: `StoreForge ${tag}`, feedLabel: o.country, contentLanguage: 'en', countries: [o.country] })).dataSourceId;
      await save({ dataSourceId: r.dataSourceId });
    }
    if (!r.catalogId) {
      // Ads ↔ Merchant Center link: request from Ads, accept on MC (both idempotent)
      await this.c.createProductLink(cid, r.merchantCenterId!);
      await this.c.approveAdsLink(r.merchantCenterId!, cid);
      r.catalogId = `mc:${r.merchantCenterId}`;
      await save({ catalogId: r.catalogId });
    }
    if (!r.conversionActionId || !r.conversionTag) {
      const q = `SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name, conversion_action.tag_snippets FROM conversion_action WHERE conversion_action.name LIKE '%${tag}%'`;
      let row = (await this.c.search(cid, q))[0];
      if (!row) {
        await this.c.mutate(cid, [{ conversionActionOperation: { create: { name: `StoreForge purchase ${tag}`, type: 'WEBPAGE', category: 'PURCHASE', status: 'ENABLED', countingType: 'ONE_PER_CLICK', valueSettings: { defaultValue: 0, alwaysUseDefaultValue: false } } } }]);
        row = (await this.c.search(cid, q))[0];
      }
      const snippet = row?.conversionAction?.tagSnippets?.[0]?.eventSnippet ?? '';
      r.conversionActionId = row?.conversionAction?.resourceName ?? null;
      r.conversionTag = /'send_to': '([^']+)'/.exec(snippet)?.[1] ?? null;
      await save({ conversionActionId: r.conversionActionId, conversionTag: r.conversionTag });
    }
    if (!r.billingRef) {
      let bs = (await this.c.search(cid, 'SELECT billing_setup.resource_name, billing_setup.status FROM billing_setup') as any[])[0]?.billingSetup?.resourceName;
      if (!bs) {
        // Consolidated billing: the MCC's payments account pays; we re-bill the merchant via Ad Fuel
        const res = await this.c.mutate(cid, [{ billingSetupOperation: { create: { paymentsAccount: `customers/${this.cfg.mcc}/paymentsAccounts/${this.cfg.paymentsAccount.replace(/-/g, '')}`, startTimeType: 'NOW' } } }]);
        bs = res.mutateOperationResponses[0]?.billingSetupResult?.resourceName;
      }
      r.billingRef = bs ?? null;
      await save({ billingRef: r.billingRef });
    }
    return { ...r, externalId: cid, name: `${o.storeName} ${tag}`, currency: o.currency, timezone: o.timezone, status: 'ready' } as ProvisionResult;
  }

  async syncFeed(acct: AccountRef, products: FeedProduct[]): Promise<FeedResult> {
    const ds = `accounts/${acct.merchantCenterId}/dataSources/${acct.dataSourceId}`;
    for (const p of products) {
      await this.c.insertProductInput(acct.merchantCenterId!, ds, {
        offerId: p.offerId, contentLanguage: 'en', feedLabel: p.country,
        productAttributes: {
          title: clip(p.title, 150), description: clip(p.description || p.title, 5000), link: p.link, imageLink: p.imageLink,
          availability: p.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK', condition: 'NEW', brand: p.brand,
          price: { amountMicros: toMicros(p.priceMinor), currencyCode: p.currency },
          shipping: [{ country: p.country, price: { amountMicros: toMicros(p.shippingMinor), currencyCode: p.currency }, minTransitDays: String(p.etaDaysMin), maxTransitDays: String(p.etaDaysMax) }],
        },
      });
    }
    const ids = new Set(products.map((p) => p.offerId));
    const listed = (await this.c.listProducts(acct.merchantCenterId!)).filter((x) => ids.has(x.offerId));
    const res: FeedResult = { submitted: products.length, approved: 0, pending: 0, disapproved: 0, issues: [] };
    for (const x of listed) {
      const d = x.productStatus?.destinationStatuses?.[0];
      if (d?.disapprovedCountries?.length) { res.disapproved++; for (const i of x.productStatus?.itemLevelIssues ?? []) res.issues.push({ offerId: x.offerId, reason: i.description }); }
      else if (d?.approvedCountries?.length) res.approved++;
      else res.pending++;
    }
    return res;
  }

  async launch(acct: AccountRef, input: LaunchInput, refs: Refs, save: (r: Refs) => Promise<void>) {
    const cid = acct.externalId;
    if (refs.campaign) return { externalId: refs.campaign.split('/').pop()!, refs };
    // A Mutate that timed out may have committed: find it by tag before sending it again
    const found = await this.c.search(cid, `SELECT campaign.resource_name, campaign.id, campaign.name, campaign_budget.resource_name FROM campaign WHERE campaign.name LIKE '%${input.tag}%' AND campaign.status != 'REMOVED'`);
    if (found[0]?.campaign) {
      const next = { ...refs, campaign: found[0].campaign.resourceName, budget: found[0].campaignBudget?.resourceName ?? refs.budget ?? '' };
      await save(next);
      return { externalId: found[0].campaign.id, refs: next };
    }
    const tmp = (kind: string, n: number) => `customers/${cid}/${kind}/-${n}`;
    const budget = tmp('campaignBudgets', 1), campaign = tmp('campaigns', 2), group = tmp('assetGroups', 3), root = tmp('assetGroupListingGroupFilters', 4);
    const ops: MutateOperation[] = [
      { campaignBudgetOperation: { create: { resourceName: budget, name: `Budget ${input.tag}`, amountMicros: toMicros(input.dailyBudgetMinor), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
      { campaignOperation: { create: {
        resourceName: campaign, name: `${clip(input.name, 200)} ${input.tag}`, advertisingChannelType: 'PERFORMANCE_MAX', status: 'ENABLED',
        campaignBudget: budget, maximizeConversionValue: {}, shoppingSetting: { merchantId: acct.merchantCenterId, feedLabel: input.countries[0] },
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', urlExpansionOptOut: true,
      } } },
      ...input.countries.map((c) => ({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: `geoTargetConstants/${GOOGLE_GEO[c] ?? GOOGLE_GEO.US}` } } } })),
      { assetGroupOperation: { create: { resourceName: group, campaign, name: `Assets ${input.tag}`, finalUrls: [input.finalUrl], status: 'ENABLED' } } },
    ];
    let n = 10;
    const text = (t: string, field: string) => {
      const a = tmp('assets', n++);
      ops.push({ assetOperation: { create: { resourceName: a, textAsset: { text: t } } } });
      ops.push({ assetGroupAssetOperation: { create: { assetGroup: group, asset: a, fieldType: field } } });
    };
    for (const h of input.headlines.slice(0, 5)) text(clip(h, 30), 'HEADLINE');
    text(clip(input.longHeadline, 90), 'LONG_HEADLINE');
    input.descriptions.slice(0, 5).forEach((d, i) => text(clip(d, i === 0 ? 60 : 90), 'DESCRIPTION'));
    text(clip(input.businessName, 25), 'BUSINESS_NAME');
    const FIELD: Record<string, string> = { '1.91:1': 'MARKETING_IMAGE', '1:1': 'SQUARE_MARKETING_IMAGE', '4:5': 'PORTRAIT_MARKETING_IMAGE' };
    for (const img of input.images) {
      const field = FIELD[img.ratio];
      if (!field) continue;
      const a = tmp('assets', n++);
      ops.push({ assetOperation: { create: { resourceName: a, name: `${img.ratio} ${input.tag}`, imageAsset: { data: (await this.loadImage(img.url)).toString('base64') } } } });
      ops.push({ assetGroupAssetOperation: { create: { assetGroup: group, asset: a, fieldType: field } } });
    }
    // Listing groups: only the boosted product(s) from the feed
    ops.push({ assetGroupListingGroupFilterOperation: { create: { resourceName: root, assetGroup: group, type: 'SUBDIVISION', listingSource: 'SHOPPING' } } });
    for (const id of input.offerIds) ops.push({ assetGroupListingGroupFilterOperation: { create: { assetGroup: group, parentListingGroupFilter: root, type: 'UNIT_INCLUDED', listingSource: 'SHOPPING', caseValue: { productItemId: { value: id } } } } });
    ops.push({ assetGroupListingGroupFilterOperation: { create: { assetGroup: group, parentListingGroupFilter: root, type: 'UNIT_EXCLUDED', listingSource: 'SHOPPING', caseValue: { productItemId: {} } } } });

    const res = await this.c.mutate(cid, ops);
    const pick = (k: string) => res.mutateOperationResponses.find((r) => r[k])?.[k]?.resourceName ?? '';
    const next = { ...refs, campaign: pick('campaignResult'), budget: pick('campaignBudgetResult'), assetGroup: pick('assetGroupResult') };
    await save(next);
    return { externalId: next.campaign.split('/').pop()!, refs: next };
  }

  async setStatus(acct: AccountRef, _id: string, refs: Refs, on: boolean) {
    await this.c.mutate(acct.externalId, [{ campaignOperation: { update: { resourceName: refs.campaign, status: on ? 'ENABLED' : 'PAUSED' }, updateMask: 'status' } }]);
  }
  async setBudget(acct: AccountRef, _id: string, refs: Refs, dailyMinor: number) {
    await this.c.mutate(acct.externalId, [{ campaignBudgetOperation: { update: { resourceName: refs.budget, amountMicros: toMicros(dailyMinor) }, updateMask: 'amount_micros' } }]);
  }
  async status(acct: AccountRef, id: string): Promise<DeliveryStatus> {
    const row = (await this.c.search(acct.externalId, `SELECT campaign.id, campaign.status, campaign.primary_status, campaign.primary_status_reasons FROM campaign WHERE campaign.id = ${id}`))[0]?.campaign;
    const ps = row?.primaryStatus ?? 'PENDING';
    if (ps === 'NOT_ELIGIBLE') return { review: 'DISAPPROVED', delivering: false, reason: (row?.primaryStatusReasons ?? []).join(', ') || 'Not eligible' };
    if (ps === 'PENDING') return { review: 'PENDING', delivering: false, reason: 'Google is reviewing the ads' };
    return { review: 'APPROVED', delivering: ps === 'ELIGIBLE' || ps === 'LIMITED' || ps === 'LEARNING' };
  }
  async insights(acct: AccountRef, id: string, _refs: Refs, since: string, until: string): Promise<InsightRow[]> {
    const rows = await this.c.search(acct.externalId, `SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE campaign.id = ${id} AND segments.date BETWEEN '${since}' AND '${until}'`);
    return rows.map((r) => ({ date: r.segments!.date!, spendMinor: fromMicros(r.metrics?.costMicros), impressions: Number(r.metrics?.impressions ?? 0), clicks: Number(r.metrics?.clicks ?? 0), conversions: Math.round(Number(r.metrics?.conversions ?? 0)), valueMinor: Math.round(Number(r.metrics?.conversionsValue ?? 0) * 100) }));
  }
  async accountSpend(acct: AccountRef) {
    const r = await this.c.search(acct.externalId, 'SELECT customer.id, metrics.cost_micros FROM customer');
    return fromMicros(r[0]?.metrics?.costMicros);
  }
  /** Account budget (consolidated billing) = lifetime spending limit; Google stops serving at it. */
  async applyCeiling(acct: AccountRef, capMinor: number) {
    const spent = await this.accountSpend(acct);
    const target = Math.max(capMinor, spent); // can't be set below what's already spent
    const ab = (await this.c.search(acct.externalId, 'SELECT account_budget.resource_name, account_budget.approved_spending_limit_micros, account_budget.status FROM account_budget'))[0]?.accountBudget;
    if (ab && fromMicros(ab.approvedSpendingLimitMicros) === target) return { appliedMinor: target };
    await this.c.mutate(acct.externalId, [{ accountBudgetProposalOperation: { create: ab
      ? { billingSetup: acct.billingRef, proposalType: 'UPDATE', accountBudget: ab.resourceName, proposedSpendingLimitMicros: toMicros(target) }
      : { billingSetup: acct.billingRef, proposalType: 'CREATE', proposedName: 'StoreForge Ad Fuel', proposedStartTimeType: 'NOW', proposedEndTimeType: 'FOREVER', proposedSpendingLimitMicros: toMicros(target) } } }]);
    return { appliedMinor: target };
  }
  /** Enhanced conversions for web: ENHANCEMENT of the gtag purchase (transaction_id = order id). */
  async sendConversion(acct: AccountRef, ev: ServerConversion) {
    const ids: ({ hashedEmail: string } | { hashedPhoneNumber: string } | { addressInfo: Record<string, string> })[] = [];
    if (ev.hashed.emGoogle ?? ev.hashed.em) ids.push({ hashedEmail: (ev.hashed.emGoogle ?? ev.hashed.em)! });
    if (!ids.length) return { trace: 'skipped:no_identifiers' };
    const at = new Date(ev.eventTime * 1000).toISOString().replace('T', ' ').slice(0, 19) + '+00:00';
    const r = await this.c.uploadConversionAdjustments(acct.externalId, [{
      conversionAction: acct.conversionActionId!, adjustmentType: 'ENHANCEMENT', orderId: ev.orderId, userIdentifiers: ids, adjustmentDateTime: at,
      ...(ev.gclid ? { gclidDateTimePair: { gclid: ev.gclid, conversionDateTime: at } } : {}),
    }], { partialFailure: true });
    if (r.partialFailureError) throw new PlatformError(r.partialFailureError.message, 'GOOGLE', { status: 400 });
    return { trace: `google:${r.results[0]?.orderId ?? ev.orderId}` };
  }
  browserTag(acct: AccountRef): BrowserTag | null {
    return acct.conversionTag ? { kind: 'gtag', id: acct.conversionTag.split('/')[0], sendTo: acct.conversionTag } : null;
  }
  testEvents(acct: AccountRef) {
    const s = this.c as any;
    return typeof s.testEvents === 'function' ? s.testEvents(acct.externalId) : [];
  }
  recordBrowserEvent(acct: AccountRef, eventName: string, eventId: string) {
    const s = this.c as any;
    if (typeof s.record === 'function') s.record(acct.externalId, eventName, eventId, 'browser');
  }
}
/** Google Ads geo target constants for the countries we ship to */
const GOOGLE_GEO: Record<string, string> = { US: '2840', CA: '2124', GB: '2826', AU: '2036', NZ: '2554', IE: '2372' };

// =============================================================================================
// TikTok (Business Center advertiser per store; prepaid balance = spend ceiling)
// =============================================================================================
const TIKTOK_GEO: Record<string, string> = { US: '6252001', CA: '6251999', GB: '2635167', AU: '2077456', NZ: '2186224', IE: '2963597' };
export class TikTokChannel implements ManagedChannel {
  readonly channel = 'TIKTOK' as const;
  constructor(private readonly c: TikTokClient = getTikTokClient(), private readonly cfg = { bcId: env('TIKTOK_BC_ID', '7000000000000000001'), industry: env('TIKTOK_INDUSTRY_ID', '291505') }) {}
  get mode() { return this.c.mode; }
  get configured() { return this.c.mode === 'stub' || tiktokLiveConfigured(); }

  async provision(o: Parameters<ManagedChannel['provision']>[0], prev: Partial<AccountRef>, save: (p: Partial<AccountRef>) => Promise<void>): Promise<ProvisionResult> {
    const tag = tagOf(o.key);
    const r: Partial<AccountRef> = { ...prev };
    if (!r.externalId) {
      const found = await this.c.get('/bc/asset/get/', { bc_id: this.cfg.bcId, asset_type: 'ADVERTISER', filtering: { keyword: tag } });
      r.externalId = found.list?.find((a: any) => String(a.asset_name).includes(tag))?.asset_id
        ?? (await this.c.post('/bc/advertiser/create/', {
          bc_id: this.cfg.bcId,
          advertiser_info: { name: `${clip(o.storeName, 60)} ${tag}`, currency: o.currency, timezone: o.timezone, type: 'AUCTION' },
          customer_info: { company: clip(o.storeName, 100), industry: this.cfg.industry, registered_area: o.country, website: o.siteUrl },
        })).advertiser_id;
      await save({ externalId: r.externalId });
    }
    const adv = r.externalId!;
    if (!r.pixelId || !r.conversionTag) {
      const name = `StoreForge ${tag}`;
      const list = (await this.c.get('/pixel/list/', { advertiser_id: adv, name })).pixels ?? [];
      const px = list.find((p: any) => p.pixel_name === name) ?? (await this.c.post('/pixel/create/', { advertiser_id: adv, pixel_name: name, pixel_category: 'ONLINE_STORE' }));
      r.pixelId = String(px.pixel_id);
      r.conversionTag = String(px.pixel_code);
      await save({ pixelId: r.pixelId, conversionTag: r.conversionTag });
    }
    if (!r.pageId) {
      r.pageId = (await this.c.post('/identity/create/', { advertiser_id: adv, identity_type: 'CUSTOMIZED_USER', display_name: clip(o.storeName, 40) })).identity_id;
      await save({ pageId: r.pageId });
    }
    if (!r.catalogId) {
      r.catalogId = String((await this.c.post('/catalog/create/', { bc_id: this.cfg.bcId, catalog_name: `StoreForge ${tag}`, catalog_type: 'ECOM', catalog_conf: { region_code: o.country, currency: o.currency } })).catalog_id);
      await save({ catalogId: r.catalogId });
    }
    return { ...r, externalId: adv, name: `${o.storeName} ${tag}`, currency: o.currency, timezone: o.timezone, status: 'ready' } as ProvisionResult;
  }
  async syncFeed(acct: AccountRef, products: FeedProduct[]): Promise<FeedResult> {
    await this.c.post('/catalog/product/upload/', {
      bc_id: this.cfg.bcId, catalog_id: acct.catalogId,
      products: products.map((p) => ({ sku_id: p.offerId, title: clip(p.title, 255), description: clip(p.description || p.title, 10_000), availability: p.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK', brand: p.brand, image_url: p.imageLink, landing_page: { landing_page_url: p.link }, price: { price: toMajor(p.priceMinor), currency: p.currency } })),
    });
    const ids = new Set(products.map((p) => p.offerId));
    const list = ((await this.c.get('/catalog/product/get/', { bc_id: this.cfg.bcId, catalog_id: acct.catalogId })).list ?? []).filter((x: any) => ids.has(x.sku_id));
    const res: FeedResult = { submitted: products.length, approved: 0, pending: 0, disapproved: 0, issues: [] };
    for (const x of list) {
      if (x.audit_status === 'REJECTED') { res.disapproved++; for (const reason of x.reject_reasons ?? []) res.issues.push({ offerId: x.sku_id, reason }); }
      else if (x.audit_status === 'APPROVED') res.approved++;
      else res.pending++;
    }
    return res;
  }
  async launch(acct: AccountRef, input: LaunchInput, refs: Refs, save: (r: Refs) => Promise<void>) {
    const adv = acct.externalId;
    const r: Refs = { ...refs };
    const put = async (k: string, v: string) => { r[k] = v; await save({ ...r }); };
    if (!r.campaign) {
      const found = (await this.c.get('/campaign/get/', { advertiser_id: adv, filtering: { campaign_name: input.tag } })).list?.[0];
      await put('campaign', found?.campaign_id ?? (await this.c.post('/campaign/create/', { advertiser_id: adv, campaign_name: clip(`${input.name} ${input.tag}`, 512), objective_type: 'WEB_CONVERSIONS', budget_mode: 'BUDGET_MODE_INFINITE', operation_status: 'DISABLE', request_id: numericKey(`${input.tag}:campaign`) })).campaign_id);
    }
    if (!r.adgroup) {
      const found = (await this.c.get('/adgroup/get/', { advertiser_id: adv, filtering: { campaign_ids: [r.campaign] } })).list?.[0];
      await put('adgroup', found?.adgroup_id ?? (await this.c.post('/adgroup/create/', {
        advertiser_id: adv, campaign_id: r.campaign, adgroup_name: clip(`Ad group ${input.tag}`, 512), promotion_type: 'WEBSITE',
        placement_type: 'PLACEMENT_TYPE_AUTOMATIC', location_ids: input.countries.map((c) => TIKTOK_GEO[c] ?? TIKTOK_GEO.US),
        budget_mode: 'BUDGET_MODE_DAY', budget: toMajor(input.dailyBudgetMinor), schedule_type: 'SCHEDULE_FROM_NOW', schedule_start_time: ymdHms(Date.now()),
        optimization_goal: 'CONVERT', optimization_event: 'COMPLETE_PAYMENT', pixel_id: acct.pixelId, billing_event: 'OCPM', bid_type: 'BID_TYPE_NO_BID',
        request_id: numericKey(`${input.tag}:adgroup`),
      })).adgroup_id);
    }
    if (!r.ad) {
      const found = (await this.c.get('/ad/get/', { advertiser_id: adv, filtering: { adgroup_ids: [r.adgroup] } })).list?.[0];
      if (found) await put('ad', found.ad_id);
      else {
        const img = input.images.find((i) => i.ratio === '9:16') ?? input.images[0];
        const image = (await this.c.post('/file/image/ad/upload/', { advertiser_id: adv, upload_type: 'UPLOAD_BY_URL', image_url: img.url, file_name: `sf-${numericKey(img.url)}.png` })).image_id;
        const ad = await this.c.post('/ad/create/', {
          advertiser_id: adv, adgroup_id: r.adgroup, request_id: numericKey(`${input.tag}:ad`),
          creatives: [{ ad_name: clip(`Ad ${input.tag}`, 512), identity_type: 'CUSTOMIZED_USER', identity_id: acct.pageId, ad_format: 'SINGLE_IMAGE', image_ids: [image], ad_text: clip(input.primaryText, 100), display_name: clip(input.businessName, 40), landing_page_url: input.finalUrl, call_to_action: 'SHOP_NOW' }],
        });
        await put('ad', ad.ad_ids[0]);
      }
    }
    if (!r.enabled) {
      await this.c.post('/campaign/status/update/', { advertiser_id: adv, campaign_ids: [r.campaign], operation_status: 'ENABLE' });
      await put('enabled', '1');
    }
    return { externalId: r.campaign, refs: r };
  }
  async setStatus(acct: AccountRef, id: string, _refs: Refs, on: boolean) {
    await this.c.post('/campaign/status/update/', { advertiser_id: acct.externalId, campaign_ids: [id], operation_status: on ? 'ENABLE' : 'DISABLE' });
  }
  async setBudget(acct: AccountRef, _id: string, refs: Refs, dailyMinor: number) {
    await this.c.post('/adgroup/budget/update/', { advertiser_id: acct.externalId, budget: [{ adgroup_id: refs.adgroup, budget: toMajor(dailyMinor) }] });
  }
  async status(acct: AccountRef, _id: string, refs: Refs): Promise<DeliveryStatus> {
    const ad = (await this.c.get('/ad/get/', { advertiser_id: acct.externalId, filtering: { adgroup_ids: [refs.adgroup] } })).list?.[0];
    const s = ad?.secondary_status ?? 'AD_STATUS_REVIEW';
    if (s === 'AD_STATUS_AUDIT_DENY' || s === 'AD_STATUS_REAUDIT_DENY') return { review: 'DISAPPROVED', delivering: false, reason: (ad?.reject_info ?? []).map((x: any) => x.reason).join('; ') || 'Rejected in review' };
    if (s === 'AD_STATUS_REVIEW' || s === 'AD_STATUS_REAUDIT') return { review: 'PENDING', delivering: false, reason: 'TikTok is reviewing the ad' };
    return { review: 'APPROVED', delivering: s === 'AD_STATUS_DELIVERY_OK' };
  }
  async insights(acct: AccountRef, id: string, _refs: Refs, since: string, until: string): Promise<InsightRow[]> {
    const r = await this.c.get('/report/integrated/get/', {
      advertiser_id: acct.externalId, report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN', dimensions: ['campaign_id', 'stat_time_day'],
      metrics: ['spend', 'impressions', 'clicks', 'complete_payment', 'total_complete_payment_rate'], start_date: since, end_date: until, page_size: 1000,
      filtering: [{ field_name: 'campaign_ids', filter_type: 'IN', filter_value: JSON.stringify([id]) }],
    });
    return (r.list ?? []).map((x: any) => {
      const spendMinor = fromMajor(x.metrics.spend);
      return { date: String(x.dimensions.stat_time_day).slice(0, 10), spendMinor, impressions: Number(x.metrics.impressions), clicks: Number(x.metrics.clicks), conversions: Number(x.metrics.complete_payment), valueMinor: Math.round(spendMinor * Number(x.metrics.total_complete_payment_rate ?? 0)) };
    });
  }
  async accountSpend(acct: AccountRef) {
    const r = await this.c.get('/report/integrated/get/', { advertiser_id: acct.externalId, report_type: 'BASIC', data_level: 'AUCTION_ADVERTISER', dimensions: ['advertiser_id'], metrics: ['spend'], query_lifetime: true });
    return fromMajor(r.list?.[0]?.metrics?.spend);
  }
  /**
   * Prepaid balance = ceiling − lifetime spend. Moves only the difference from the balance read now,
   * so a retried (timed-out) transfer can't double-fund: the next read already includes it.
   */
  async applyCeiling(acct: AccountRef, capMinor: number) {
    const spent = await this.accountSpend(acct);
    const bal = fromMajor(((await this.c.get('/advertiser/balance/get/', { bc_id: this.cfg.bcId, filtering: { keyword: acct.externalId } })).advertiser_account_list ?? []).find((a: any) => String(a.advertiser_id) === acct.externalId)?.cash_balance);
    const want = Math.max(0, capMinor - spent);
    const delta = want - bal;
    if (delta > 0) await this.c.post('/bc/transfer/', { bc_id: this.cfg.bcId, advertiser_id: acct.externalId, transfer_type: 'RECHARGE', cash_amount: toMajor(delta) });
    if (delta < 0) await this.c.post('/bc/transfer/', { bc_id: this.cfg.bcId, advertiser_id: acct.externalId, transfer_type: 'DEDUCT', cash_amount: toMajor(-delta) });
    return { appliedMinor: spent + want };
  }
  async sendConversion(acct: AccountRef, ev: ServerConversion, testCode?: string | null) {
    await this.c.post('/event/track/', {
      event_source: 'web', event_source_id: acct.conversionTag, ...(testCode ? { test_event_code: testCode } : {}),
      data: [{
        event: 'CompletePayment', event_time: ev.eventTime, event_id: ev.eventId,
        user: { ...(ev.hashed.em ? { email: ev.hashed.em } : {}), ...(ev.hashed.external_id ? { external_id: ev.hashed.external_id } : {}), ...(ev.ttclid ? { ttclid: ev.ttclid } : {}), ...(ev.ttp ? { ttp: ev.ttp } : {}), ...(ev.ip ? { ip: ev.ip } : {}), ...(ev.ua ? { user_agent: ev.ua } : {}) },
        properties: { currency: ev.currency, value: toMajor(ev.valueMinor), content_type: 'product', contents: ev.contentIds.map((id) => ({ content_id: id })) },
        ...(ev.sourceUrl ? { page: { url: ev.sourceUrl } } : {}),
      }],
    });
    return { trace: `tiktok:${ev.eventId}` };
  }
  browserTag(acct: AccountRef): BrowserTag | null { return acct.conversionTag ? { kind: 'tiktok', id: acct.conversionTag } : null; }
  testEvents(acct: AccountRef) { const s = this.c as any; return typeof s.testEvents === 'function' && acct.conversionTag ? s.testEvents(acct.conversionTag) : []; }
  recordBrowserEvent(acct: AccountRef, eventName: string, eventId: string) { const s = this.c as any; if (typeof s.record === 'function' && acct.conversionTag) s.record(acct.externalId, acct.conversionTag, eventName, eventId, 'browser'); }
}

// =============================================================================================
// Meta managed (ad account in StoreForge's Business Manager; spend_cap = ceiling)
// =============================================================================================
/** Meta won't take a spend_cap under this, and 0 would REMOVE the cap. */
export const META_MIN_SPEND_CAP_MINOR = () => Number(process.env.META_MIN_SPEND_CAP_CENTS ?? 10_000);
export class MetaManagedChannel implements ManagedChannel {
  readonly channel = 'META' as const;
  constructor(private readonly g: MetaGraph = getMetaGraph(), private readonly cfg = { businessId: env('META_BUSINESS_ID', '100000000000001'), pageId: env('META_MANAGED_PAGE_ID', '104857600999999'), timezoneId: Number(env('META_MANAGED_TIMEZONE_ID', '1')) }) {}
  get mode() { return this.g.mode; }
  get configured() { return this.g.mode === 'stub' || metaManagedLiveConfigured(); }

  async provision(o: Parameters<ManagedChannel['provision']>[0], prev: Partial<AccountRef>, save: (p: Partial<AccountRef>) => Promise<void>): Promise<ProvisionResult> {
    const tag = tagOf(o.key);
    const r: Partial<AccountRef> = { ...prev };
    if (!r.externalId) {
      const found = (await this.g.call('GET', `${this.cfg.businessId}/owned_ad_accounts`, { fields: 'id,name,account_status', filtering: [{ field: 'name', operator: 'CONTAIN', value: tag }] })).data?.[0];
      r.externalId = found?.id ?? (await this.g.call('POST', `${this.cfg.businessId}/adaccount`, { name: `${clip(o.storeName, 60)} ${tag}`, currency: o.currency, timezone_id: this.cfg.timezoneId, end_advertiser: this.cfg.pageId, media_agency: 'NONE', partner: 'NONE' })).id;
      await save({ externalId: r.externalId });
    }
    if (!r.pixelId) {
      const name = `StoreForge ${tag}`;
      const list = (await this.g.call('GET', `${this.cfg.businessId}/adspixels`, { fields: 'id,name' })).data ?? [];
      r.pixelId = list.find((p: any) => p.name === name)?.id ?? (await this.g.call('POST', `${this.cfg.businessId}/adspixels`, { name })).id;
      await this.g.call('POST', `${r.pixelId}/shared_accounts`, { account_id: r.externalId!.replace(/^act_/, ''), business: this.cfg.businessId });
      await save({ pixelId: r.pixelId });
    }
    r.pageId = this.cfg.pageId;
    return { ...r, externalId: r.externalId!, name: `${o.storeName} ${tag}`, currency: o.currency, timezone: o.timezone, status: 'ready' } as ProvisionResult;
  }
  async syncFeed(_acct: AccountRef, products: FeedProduct[]): Promise<FeedResult> {
    return { submitted: products.length, approved: products.length, pending: 0, disapproved: 0, issues: [] }; // link ads: no catalog needed
  }
  async launch(acct: AccountRef, input: LaunchInput, refs: Refs, save: (r: Refs) => Promise<void>) {
    const act = acct.externalId;
    const r: Refs = { ...refs };
    const put = async (k: string, v: string) => { r[k] = v; await save({ ...r }); };
    if (!r.campaign) {
      const found = (await this.g.call('GET', `${act}/campaigns`, { fields: 'id,name', filtering: [{ field: 'name', operator: 'CONTAIN', value: input.tag }] })).data?.[0];
      await put('campaign', found?.id ?? (await this.g.call('POST', `${act}/campaigns`, { name: `${input.name} ${input.tag}`, objective: 'OUTCOME_SALES', status: 'PAUSED', special_ad_categories: [] })).id);
    }
    if (!r.adset) {
      // the ad set carries the budget: never create two (found by tag after a timeout)
      const found = (await this.g.call('GET', `${act}/adsets`, { fields: 'id,name', filtering: [{ field: 'name', operator: 'CONTAIN', value: input.tag }] })).data?.[0];
      await put('adset', found?.id ?? (await this.g.call('POST', `${act}/adsets`, {
        name: `Ad set ${input.tag}`, campaign_id: r.campaign, daily_budget: String(input.dailyBudgetMinor), billing_event: 'IMPRESSIONS', optimization_goal: 'OFFSITE_CONVERSIONS',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP', promoted_object: { pixel_id: acct.pixelId, custom_event_type: 'PURCHASE' }, targeting: { geo_locations: { countries: input.countries } }, status: 'ACTIVE',
      })).id);
    }
    // QA r4 #1: creative and ad are looked up by their tagged name too, so a retry after a lost
    // response (the POST committed at Meta, the reply never arrived) reuses them instead of
    // creating a second creative/ad.
    if (!r.creative) {
      const name = `Creative ${input.tag}`;
      const existing = ((await this.g.call('GET', `${act}/adcreatives`, { fields: 'id,name', filtering: [{ field: 'name', operator: 'CONTAIN', value: input.tag }], limit: 500 })).data ?? []).find((c: any) => c.name === name);
      if (existing) await put('creative', existing.id);
    }
    if (!r.creative) {
      const img = input.images.find((i) => i.ratio === '1.91:1') ?? input.images[0];
      await put('creative', (await this.g.call('POST', `${act}/adcreatives`, { name: `Creative ${input.tag}`, object_story_spec: { page_id: acct.pageId, link_data: { link: input.finalUrl, message: input.primaryText, name: clip(input.headlines[0] ?? input.name, 40), description: clip(input.descriptions[0] ?? '', 30), picture: img?.url, call_to_action: { type: 'SHOP_NOW' } } } })).id);
    }
    if (!r.ad) {
      const existing = ((await this.g.call('GET', `${r.adset}/ads`, { fields: 'id,name', limit: 500 })).data ?? []).find((a: any) => a.name === `Ad ${input.tag}`);
      if (existing) await put('ad', existing.id);
    }
    if (!r.ad) await put('ad', (await this.g.call('POST', `${act}/ads`, { name: `Ad ${input.tag}`, adset_id: r.adset, creative: { creative_id: r.creative }, status: 'ACTIVE' })).id);
    if (!r.enabled) { await this.g.call('POST', r.campaign, { status: 'ACTIVE' }); await put('enabled', '1'); }
    return { externalId: r.campaign, refs: r };
  }
  async setStatus(_acct: AccountRef, id: string, _refs: Refs, on: boolean) { await this.g.call('POST', id, { status: on ? 'ACTIVE' : 'PAUSED' }); }
  async setBudget(_acct: AccountRef, _id: string, refs: Refs, dailyMinor: number) { await this.g.call('POST', refs.adset, { daily_budget: String(dailyMinor) }); }
  async status(_acct: AccountRef, id: string): Promise<DeliveryStatus> {
    const c = await this.g.call('GET', id, { fields: 'status,effective_status' });
    if (c.effective_status === 'DISAPPROVED' || c.effective_status === 'WITH_ISSUES') return { review: 'DISAPPROVED', delivering: false, reason: 'Meta rejected the ad' };
    if (c.effective_status === 'IN_PROCESS' || c.effective_status === 'PENDING_REVIEW') return { review: 'PENDING', delivering: false, reason: 'Meta is reviewing the ad' };
    return { review: 'APPROVED', delivering: c.effective_status === 'ACTIVE' };
  }
  async insights(_acct: AccountRef, id: string, _refs: Refs, since: string, until: string): Promise<InsightRow[]> {
    const r = await this.g.call('GET', `${id}/insights`, { fields: 'spend,impressions,clicks,actions,action_values', time_increment: 1, time_range: { since, until } });
    const pick = (arr: any[] | undefined) => Number((arr ?? []).find((a) => a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase')?.value ?? 0);
    return (r.data ?? []).map((x: any) => ({ date: x.date_start, spendMinor: fromMajor(x.spend), impressions: Number(x.impressions ?? 0), clicks: Number(x.clicks ?? 0), conversions: Math.round(pick(x.actions)), valueMinor: Math.round(pick(x.action_values) * 100) }));
  }
  async accountSpend(acct: AccountRef) { return Number((await this.g.call('GET', acct.externalId, { fields: 'amount_spent,spend_cap' })).amount_spent ?? 0); }
  /** spend_cap is lifetime account spend in cents. NEVER 0 (= no cap); never below spent or Meta's minimum. */
  async applyCeiling(acct: AccountRef, capMinor: number) {
    const a = await this.g.call('GET', acct.externalId, { fields: 'amount_spent,spend_cap' });
    const spent = Number(a.amount_spent ?? 0);
    const target = Math.max(capMinor, spent, META_MIN_SPEND_CAP_MINOR(), 1);
    if (Number(a.spend_cap) !== target) await this.g.call('POST', acct.externalId, { spend_cap: String(target) });
    return { appliedMinor: target };
  }
  async sendConversion(acct: AccountRef, ev: ServerConversion, testCode?: string | null) {
    const ud: Record<string, unknown> = {};
    for (const k of ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'external_id'] as const) if (ev.hashed[k]) ud[k] = [ev.hashed[k]];
    if (ev.ip) ud.client_ip_address = ev.ip;
    if (ev.ua) ud.client_user_agent = ev.ua;
    if (ev.fbp) ud.fbp = ev.fbp;
    if (ev.fbc) ud.fbc = ev.fbc;
    const r = await this.g.call('POST', `${acct.pixelId}/events`, {
      data: [{ event_name: 'Purchase', event_time: ev.eventTime, event_id: ev.eventId, action_source: 'website', event_source_url: ev.sourceUrl ?? undefined, user_data: ud, custom_data: { value: toMajor(ev.valueMinor), currency: ev.currency, content_ids: ev.contentIds, content_type: 'product', num_items: ev.numItems, order_id: ev.orderId } }],
      ...(testCode ? { test_event_code: testCode } : {}),
    });
    return { trace: String(r.fbtrace_id ?? 'meta') };
  }
  browserTag(acct: AccountRef): BrowserTag | null { return acct.pixelId ? { kind: 'meta', id: acct.pixelId } : null; }
  testEvents(acct: AccountRef) { const s = this.g as any; return typeof s.testEvents === 'function' && acct.pixelId ? s.testEvents(acct.pixelId) : []; }
  recordBrowserEvent(acct: AccountRef, eventName: string, eventId: string) { const s = this.g as any; if (typeof s.record === 'function' && acct.pixelId) s.record(acct.pixelId, eventName, eventId, 'browser', null); }
}

const overrides: Partial<Record<Channel, ManagedChannel>> = {};
const cache: Partial<Record<Channel, ManagedChannel>> = {};
export function getManagedChannel(ch: Channel): ManagedChannel {
  if (overrides[ch]) return overrides[ch]!;
  cache[ch] ??= ch === 'GOOGLE' ? new GoogleChannel() : ch === 'TIKTOK' ? new TikTokChannel() : new MetaManagedChannel();
  return cache[ch]!;
}
export function setManagedChannelForTests(ch: Channel, a: ManagedChannel | null) { if (a) overrides[ch] = a; else delete overrides[ch]; }
