import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { AdSim, latency, utcDay } from '../sim';
import { fromMicros } from '../types';
import { GoogleAdsError, type ConversionAdjustment, type GoogleAdsClient, type GoogleAdsRow, type MerchantClient, type MerchantProduct, type MutateOperation, type ProductInput } from './types';

const HEX64 = /^[0-9a-f]{64}$/;
/** Live platforms require https; the stub also accepts dev hosts (localhost, *.local) so the demo works. */
const okUrl = (u: string) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1|[\w.-]+\.local)(:\d+)?\//.test(u);
const POLICY = /\b(cure[sd]?|miracle|guaranteed? (results|income)|lose \d+ ?(lb|kg|pounds))\b/i;
const bad = (message: string, errorCode: Record<string, string>) => new GoogleAdsError(message, 400, 'INVALID_ARGUMENT', [{ errorCode, message }], `stub-${randomBytes(6).toString('hex')}`);
const MIN: Record<string, number> = { HEADLINE: 3, LONG_HEADLINE: 1, DESCRIPTION: 2, BUSINESS_NAME: 1, MARKETING_IMAGE: 1, SQUARE_MARKETING_IMAGE: 1 };

/**
 * Stub Google Ads API + Merchant API. Same method shapes as the live REST clients; delivery and
 * spend come from AdSim (account budget = spend ceiling). GAQL is matched by the handful of query
 * shapes the adapter sends (not a general GAQL engine).
 */
export class StubGoogle implements GoogleAdsClient, MerchantClient {
  readonly mode = 'stub' as const;
  readonly sim: AdSim;
  /** Test hooks: throw before the call, or commit then throw (a timeout after Google applied it) */
  failNext: Partial<Record<string, Error>> = {};
  failAfterCommit: Partial<Record<string, Error>> = {};
  constructor(file: string | null = process.env.NODE_ENV === 'test' ? null : process.env.GOOGLE_STUB_STATE_FILE ?? join(process.cwd(), '.stub-google.json')) {
    this.sim = new AdSim(file);
  }
  private get o() { return this.sim.state.objects; }
  private async enter(m: string) {
    await latency();
    const e = this.failNext[m];
    if (e) { delete this.failNext[m]; throw e; }
  }
  private after(m: string) {
    const e = this.failAfterCommit[m];
    if (e) { delete this.failAfterCommit[m]; throw e; }
  }
  private customer(id: string) {
    const a = this.sim.account(id);
    if (!a) throw new GoogleAdsError(`The customer account can't be accessed because it is not yet enabled or has been deactivated.`, 403, 'PERMISSION_DENIED', [{ errorCode: { authorizationError: 'CUSTOMER_NOT_ENABLED' }, message: 'Customer not enabled' }]);
    return a;
  }

  // ---------------------------------------------------------------- Google Ads
  async createCustomerClient(managerId: string, o: { descriptiveName: string; currencyCode: string; timeZone: string }) {
    await this.enter('createCustomerClient');
    if (!/^\d{10}$/.test(managerId)) throw bad('Invalid manager customer id', { fieldError: 'INVALID_VALUE' });
    const id = String(4_000_000_000 + Number(this.sim.nextId()));
    this.sim.addAccount({ id, name: o.descriptiveName, currency: o.currencyCode, timezone: o.timeZone, extra: { manager: managerId } });
    this.after('createCustomerClient');
    return { resourceName: `customers/${id}` };
  }

  async search(customerId: string, q: string): Promise<GoogleAdsRow[]> {
    await this.enter('search');
    const like = /LIKE '%(.+?)%'/.exec(q)?.[1];
    const idEq = /campaign\.id = (\d+)/.exec(q)?.[1];
    const between = /segments\.date BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/.exec(q);
    if (/FROM customer_client/.test(q)) {
      return Object.values(this.sim.state.accounts)
        .filter((a) => a.extra?.manager === customerId && (!like || a.name.includes(like)))
        .map((a) => ({ customerClient: { id: a.id, descriptiveName: a.name, currencyCode: a.currency, timeZone: a.timezone, status: 'ENABLED' } }));
    }
    this.customer(customerId);
    if (/FROM conversion_action/.test(q)) {
      return Object.values(this.o).filter((x: any) => x.kind === 'conversionAction' && x.customer === customerId && (!like || x.name.includes(like)))
        .map((x: any) => ({ conversionAction: { resourceName: x.rn, id: x.id, name: x.name, tagSnippets: [{ type: 'WEBPAGE', eventSnippet: `gtag('event', 'conversion', {'send_to': '${x.sendTo}'});` }] } }));
    }
    if (/FROM billing_setup/.test(q)) {
      return Object.values(this.o).filter((x: any) => x.kind === 'billingSetup' && x.customer === customerId).map((x: any) => ({ billingSetup: { resourceName: x.rn, status: 'APPROVED' } } as any));
    }
    if (/FROM account_budget/.test(q)) {
      return Object.values(this.o).filter((x: any) => x.kind === 'accountBudget' && x.customer === customerId)
        .map((x: any) => ({ accountBudget: { resourceName: x.rn, approvedSpendingLimitMicros: String(x.limitMicros), status: 'APPROVED' } }));
    }
    if (/FROM customer\b/.test(q)) {
      return [{ customer: { id: customerId, descriptiveName: this.sim.account(customerId)!.name }, metrics: { costMicros: String(this.sim.accountSpend(customerId) * 10_000) } }];
    }
    if (/FROM campaign\b/.test(q)) {
      const camps = Object.values(this.o).filter((x: any) => x.kind === 'campaign' && x.customer === customerId && (!like || x.name.includes(like)) && (!idEq || x.id === idEq)) as any[];
      if (between) {
        const rows: GoogleAdsRow[] = [];
        for (const c of camps) {
          for (const r of this.sim.daily(c.id, between[1], between[2])) {
            rows.push({ campaign: this.campaignRow(c), segments: { date: r.date }, metrics: { costMicros: String(r.spendMinor * 10_000), impressions: String(r.impressions), clicks: String(r.clicks), conversions: r.conversions, conversionsValue: r.valueMinor / 100 } });
          }
        }
        return rows;
      }
      return camps.map((c) => ({ campaign: this.campaignRow(c), campaignBudget: { resourceName: c.budget, amountMicros: String(this.sim.budget(c.id) * 10_000) } }));
    }
    throw bad(`Unsupported query in stub: ${q.slice(0, 80)}`, { queryError: 'PROHIBITED_RESOURCE_TYPE_IN_FROM_CLAUSE' });
  }
  private campaignRow(c: any) {
    const sc = this.sim.campaign(c.id)!;
    const review = this.sim.reviewOf(sc);
    const enabled = this.sim.isActive(c.id);
    const primaryStatus = review === 'DISAPPROVED' ? 'NOT_ELIGIBLE' : !enabled ? 'PAUSED' : review === 'PENDING' ? 'PENDING' : 'ELIGIBLE';
    return { resourceName: c.rn, id: c.id, name: c.name, status: (enabled ? 'ENABLED' : 'PAUSED') as 'ENABLED' | 'PAUSED', primaryStatus, primaryStatusReasons: review === 'DISAPPROVED' ? ['ASSET_GROUP_DISAPPROVED'] : review === 'PENDING' && enabled ? ['UNDER_REVIEW'] : [] };
  }

  async mutate(customerId: string, ops: MutateOperation[]) {
    await this.enter('mutate');
    const cust = this.customer(customerId);
    const temp = new Map<string, string>();
    const resolve = (rn: unknown) => (typeof rn === 'string' && temp.has(rn) ? temp.get(rn)! : (rn as string));
    const pending: (() => void)[] = [];
    const responses: Record<string, { resourceName: string }>[] = [];
    const groups = new Map<string, Record<string, number>>();
    const textOf = new Map<string, string>();
    const newRn = (kind: string, tempRn?: unknown) => {
      const id = this.sim.nextId(9_000_000_000);
      const rn = `customers/${customerId}/${kind}/${id}`;
      if (typeof tempRn === 'string') temp.set(tempRn, rn);
      return { id, rn };
    };
    // Validate everything first, apply at the end: Mutate is atomic.
    for (const op of ops) {
      if ('campaignBudgetOperation' in op) {
        const b = op.campaignBudgetOperation;
        if (b.create) {
          const micros = Number(b.create.amountMicros);
          if (!(micros >= 1_000_000)) throw bad('Budget amount is too small.', { campaignBudgetError: 'MONEY_AMOUNT_TOO_SMALL' });
          const { rn } = newRn('campaignBudgets', b.create.resourceName);
          pending.push(() => { this.o[rn] = { kind: 'budget', rn, customer: customerId, micros }; });
          responses.push({ campaignBudgetResult: { resourceName: rn } });
        } else if (b.update) {
          const rn = String(b.update.resourceName);
          const micros = Number(b.update.amountMicros);
          if (!this.o[rn]) throw bad('Resource not found.', { mutateError: 'RESOURCE_NOT_FOUND' });
          pending.push(() => {
            this.o[rn].micros = micros;
            const camp = Object.values(this.o).find((x: any) => x.kind === 'campaign' && x.budget === rn) as any;
            if (camp) this.sim.setBudget(camp.id, fromMicros(micros));
          });
          responses.push({ campaignBudgetResult: { resourceName: rn } });
        }
      } else if ('campaignOperation' in op) {
        const c = op.campaignOperation;
        if (c.create) {
          if (c.create.advertisingChannelType !== 'PERFORMANCE_MAX') throw bad('Only PERFORMANCE_MAX in stub', { campaignError: 'CANNOT_SET_FIELD' });
          const budget = resolve(c.create.campaignBudget);
          const ss = c.create.shoppingSetting as { merchantId?: string } | undefined;
          if (!ss?.merchantId) throw bad('A Merchant Center id is required for retail Performance Max.', { campaignError: 'MISSING_SHOPPING_SETTING' });
          if (!(cust.extra as any)?.links?.[ss.merchantId]?.approved) throw bad('The Merchant Center account is not linked to this Google Ads account.', { campaignError: 'MERCHANT_NOT_LINKED' });
          if (!c.create.containsEuPoliticalAdvertising) throw bad('contains_eu_political_advertising is required.', { fieldError: 'REQUIRED' });
          const { id, rn } = newRn('campaigns', c.create.resourceName);
          const name = String(c.create.name);
          const status = c.create.status === 'ENABLED';
          pending.push(() => {
            const micros = this.o[budget]?.micros ?? pendingBudget.get(budget) ?? 0;
            this.o[rn] = { kind: 'campaign', rn, id, customer: customerId, name, budget };
            this.sim.addCampaign({ id, account: customerId, name, budgetMinor: fromMicros(micros), active: status, disapprove: false });
          });
          responses.push({ campaignResult: { resourceName: rn } });
        } else if (c.update) {
          const rn = String(c.update.resourceName);
          const x = this.o[rn];
          if (!x) throw bad('Resource not found.', { mutateError: 'RESOURCE_NOT_FOUND' });
          pending.push(() => { if (c.update!.status) this.sim.setActive(x.id, c.update!.status === 'ENABLED'); });
          responses.push({ campaignResult: { resourceName: rn } });
        }
      } else if ('assetOperation' in op) {
        const a = op.assetOperation.create;
        const text = (a.textAsset as { text?: string } | undefined)?.text;
        const img = a.imageAsset as { data?: string } | undefined;
        if (text !== undefined && POLICY.test(text)) {
          throw new GoogleAdsError('A policy violation was detected.', 400, 'INVALID_ARGUMENT', [{ errorCode: { policyFindingError: 'POLICY_FINDING' }, message: `Unacceptable claims: "${text}"` }]);
        }
        if (img && !(img.data && img.data.length > 16)) throw bad('Image data is empty or invalid.', { imageError: 'INVALID_IMAGE' });
        const { rn } = newRn('assets', a.resourceName);
        if (text !== undefined) textOf.set(rn, text);
        pending.push(() => { this.o[rn] = { kind: 'asset', rn, customer: customerId, text: text ?? null }; });
        responses.push({ assetResult: { resourceName: rn } });
      } else if ('assetGroupOperation' in op) {
        const g = op.assetGroupOperation.create;
        const camp = resolve(g.campaign);
        if (!(g.finalUrls as string[] | undefined)?.every((u) => /^https?:\/\//.test(u))) throw bad('Final URL is invalid.', { assetGroupError: 'INVALID_FINAL_URL' });
        const { rn } = newRn('assetGroups', g.resourceName);
        groups.set(rn, {});
        pending.push(() => { this.o[rn] = { kind: 'assetGroup', rn, customer: customerId, campaign: camp }; });
        responses.push({ assetGroupResult: { resourceName: rn } });
      } else if ('assetGroupAssetOperation' in op) {
        const l = op.assetGroupAssetOperation.create;
        const g = resolve(l.assetGroup);
        const counts = groups.get(g);
        if (counts) counts[String(l.fieldType)] = (counts[String(l.fieldType)] ?? 0) + 1;
        responses.push({ assetGroupAssetResult: { resourceName: `${g}~${resolve(l.asset)}~${l.fieldType}` } });
      } else if ('assetGroupListingGroupFilterOperation' in op) {
        const f = op.assetGroupListingGroupFilterOperation.create;
        const g = resolve(f.assetGroup);
        pending.push(() => { if (this.o[g]) this.o[g].listing = true; });
        responses.push({ assetGroupListingGroupFilterResult: { resourceName: `${g}~listing` } });
      } else if ('conversionActionOperation' in op) {
        const c = op.conversionActionOperation.create;
        const { id, rn } = newRn('conversionActions', c.resourceName);
        const sendTo = `AW-${customerId.slice(-9)}/${randomBytes(6).toString('base64url')}`;
        pending.push(() => { this.o[rn] = { kind: 'conversionAction', rn, id, customer: customerId, name: String(c.name), sendTo }; });
        responses.push({ conversionActionResult: { resourceName: rn } });
      } else if ('campaignCriterionOperation' in op) {
        const cc = (op as any).campaignCriterionOperation.create;
        responses.push({ campaignCriterionResult: { resourceName: `${resolve(cc.campaign)}~criterion~${responses.length}` } });
      } else if ('billingSetupOperation' in op) {
        const { rn } = newRn('billingSetups');
        pending.push(() => { this.o[rn] = { kind: 'billingSetup', rn, customer: customerId }; });
        responses.push({ billingSetupResult: { resourceName: rn } });
      } else if ('accountBudgetProposalOperation' in op) {
        const p = op.accountBudgetProposalOperation.create;
        const limitMicros = Number(p.proposedSpendingLimitMicros ?? p.approvedSpendingLimitMicros);
        if (!(limitMicros >= 0)) throw bad('Spending limit is invalid.', { accountBudgetProposalError: 'INVALID_SPENDING_LIMIT' });
        const spentMicros = this.sim.accountSpend(customerId) * 10_000;
        if (limitMicros < spentMicros) throw bad('The spending limit cannot be below the amount already spent.', { accountBudgetProposalError: 'SPENDING_LIMIT_LESS_THAN_ACCRUED_COST' });
        const { rn } = newRn('accountBudgetProposals');
        pending.push(() => {
          const existing = Object.values(this.o).find((x: any) => x.kind === 'accountBudget' && x.customer === customerId) as any;
          const ab = existing ?? { kind: 'accountBudget', rn: `customers/${customerId}/accountBudgets/${this.sim.nextId(7_000_000_000)}`, customer: customerId };
          ab.limitMicros = limitMicros;
          this.o[ab.rn] = ab;
          this.sim.setCap(customerId, Math.floor(limitMicros / 10_000));
        });
        responses.push({ accountBudgetProposalResult: { resourceName: rn } });
      }
    }
    const pendingBudget = new Map<string, number>();
    for (const op of ops) if ('campaignBudgetOperation' in op && op.campaignBudgetOperation.create) pendingBudget.set(String(temp.get(String(op.campaignBudgetOperation.create.resourceName))), Number(op.campaignBudgetOperation.create.amountMicros));
    for (const [g, counts] of groups) {
      for (const [field, n] of Object.entries(MIN)) {
        if ((counts[field] ?? 0) < n) throw bad(`Asset group ${g} needs at least ${n} ${field} asset(s).`, { assetGroupError: `NOT_ENOUGH_${field}_ASSET` });
      }
    }
    for (const f of pending) f();
    this.sim.save();
    this.after('mutate');
    return { mutateOperationResponses: responses };
  }

  async createProductLink(customerId: string, merchantCenterId: string) {
    await this.enter('createProductLink');
    const a = this.customer(customerId);
    const links = ((a.extra ??= {}) as any).links ??= {};
    links[merchantCenterId] = { approved: links[merchantCenterId]?.approved ?? false };
    this.sim.save();
    return { resourceName: `customers/${customerId}/productLinks/${merchantCenterId}` };
  }

  /** Every adjustment payload received (tests: exactly what would leave for Google) */
  readonly adjustmentsSent: any[] = [];
  async uploadConversionAdjustments(customerId: string, adjustments: ConversionAdjustment[], o: { partialFailure: true; validateOnly?: boolean }) {
    await this.enter('uploadConversionAdjustments');
    this.customer(customerId);
    this.adjustmentsSent.push(...adjustments.map((a) => JSON.parse(JSON.stringify(a))));
    const results: { orderId: string }[] = [];
    const errors: string[] = [];
    for (const [i, a] of adjustments.entries()) {
      const action = this.o[a.conversionAction];
      if (!action) { errors.push(`operations[${i}]: conversion action not found`); continue; }
      if (!a.orderId) { errors.push(`operations[${i}]: order_id is required for ENHANCEMENT`); continue; }
      const ids = a.userIdentifiers.flatMap((u) => Object.values(u).filter((v) => typeof v === 'string')) as string[];
      if (!ids.length || ids.some((v) => !HEX64.test(v))) { errors.push(`operations[${i}]: user identifiers must be SHA-256 hashed`); continue; }
      results.push({ orderId: a.orderId });
      if (!o.validateOnly) this.record(customerId, 'purchase', a.orderId, 'server');
    }
    this.sim.save();
    return { results, ...(errors.length ? { partialFailureError: { message: errors.join('; ') } } : {}) };
  }
  record(customerId: string, eventName: string, eventId: string, source: 'server' | 'browser') {
    const ev = this.sim.state.events;
    // Enhanced conversions: the server ENHANCEMENT joins the gtag conversion with the same order id.
    const twin = ev.find((e) => e.customer === customerId && e.eventId === eventId);
    ev.push({ customer: customerId, eventName, eventId, source, receivedAt: this.sim.now(), deduplicated: Boolean(twin) });
    if (ev.length > 500) this.sim.state.events = ev.slice(-500);
    this.sim.save();
  }
  testEvents(customerId: string) { return this.sim.state.events.filter((e) => e.customer === customerId).slice(-50).reverse(); }

  // ---------------------------------------------------------------- Merchant API
  async createSubAccount(advancedAccountId: string, o: { accountName: string; timeZone: string; languageCode: string; websiteUrl: string }) {
    await this.enter('createSubAccount');
    const accountId = this.sim.nextId(5_500_000_000);
    this.o[`mc/${accountId}`] = { kind: 'mc', accountId, parent: advancedAccountId, accountName: o.accountName, website: o.websiteUrl, products: {} };
    this.sim.save();
    this.after('createSubAccount');
    return { name: `accounts/${accountId}`, accountId };
  }
  async listSubAccounts(advancedAccountId: string) {
    await this.enter('listSubAccounts');
    return Object.values(this.o).filter((x: any) => x.kind === 'mc' && x.parent === advancedAccountId).map((x: any) => ({ name: `accounts/${x.accountId}`, accountId: x.accountId, accountName: x.accountName }));
  }
  private mc(accountId: string) {
    const m = this.o[`mc/${accountId}`];
    if (!m) throw new GoogleAdsError(`Account ${accountId} not found.`, 404, 'NOT_FOUND');
    return m;
  }
  async createDataSource(accountId: string, o: { displayName: string; feedLabel: string; contentLanguage: string; countries: string[] }) {
    await this.enter('createDataSource');
    const m = this.mc(accountId);
    const dataSourceId = m.dataSourceId ?? this.sim.nextId(10_000);
    m.dataSourceId = dataSourceId;
    m.feed = o;
    this.sim.save();
    return { name: `accounts/${accountId}/dataSources/${dataSourceId}`, dataSourceId };
  }
  async insertProductInput(accountId: string, dataSource: string, input: ProductInput) {
    await this.enter('insertProductInput');
    const m = this.mc(accountId);
    if (!dataSource.endsWith(`/dataSources/${m.dataSourceId}`)) throw new GoogleAdsError('Data source not found.', 404, 'NOT_FOUND');
    const p = input.productAttributes;
    if (!input.offerId || !p.title || !p.price?.amountMicros) throw new GoogleAdsError('offerId, title and price are required.', 400, 'INVALID_ARGUMENT');
    const issues: { code: string; description: string; severity: string }[] = [];
    if (!okUrl(p.link)) issues.push({ code: 'invalid_url', description: 'Invalid product page URL (https required)', severity: 'DISAPPROVED' });
    if (!okUrl(p.imageLink)) issues.push({ code: 'image_link_broken', description: 'Image could not be crawled', severity: 'DISAPPROVED' });
    if (POLICY.test(`${p.title} ${p.description}`)) issues.push({ code: 'policy_unsupported_claims', description: 'Unreliable claims', severity: 'DISAPPROVED' });
    if (Number(p.price.amountMicros) <= 0) issues.push({ code: 'price_missing', description: 'Missing price', severity: 'DISAPPROVED' });
    m.products[input.offerId] = { offerId: input.offerId, at: this.sim.now(), issues };
    this.sim.save();
    return { name: `accounts/${accountId}/productInputs/en~${input.feedLabel}~${input.offerId}` };
  }
  async listProducts(accountId: string): Promise<MerchantProduct[]> {
    await this.enter('listProducts');
    const m = this.mc(accountId);
    const now = this.sim.now();
    return Object.values(m.products as Record<string, any>).map((x) => {
      const disapproved = x.issues.some((i: any) => i.severity === 'DISAPPROVED');
      const pending = !disapproved && now - x.at < this.sim.reviewMs;
      const country = m.feed?.countries?.[0] ?? 'US';
      return {
        name: `accounts/${accountId}/products/en~${country}~${x.offerId}`, offerId: x.offerId,
        productStatus: { destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', ...(disapproved ? { disapprovedCountries: [country] } : pending ? { pendingCountries: [country] } : { approvedCountries: [country] }) }], itemLevelIssues: x.issues },
      };
    });
  }
  async approveAdsLink(accountId: string, adsCustomerId: string) {
    await this.enter('approveAdsLink');
    this.mc(accountId);
    const a = this.customer(adsCustomerId);
    const links = ((a.extra ??= {}) as any).links ??= {};
    if (!links[accountId]) throw new GoogleAdsError('No pending link request from this Google Ads account.', 400, 'FAILED_PRECONDITION');
    links[accountId].approved = true;
    this.sim.save();
  }
  /** Dev helper used by the stub only: today's date string */
  today() { return utcDay(this.sim.now()); }
}
