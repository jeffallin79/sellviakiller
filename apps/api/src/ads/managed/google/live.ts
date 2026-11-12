import { GOOGLE_ADS_VERSION, GoogleAdsError, type ConversionAdjustment, type GoogleAdsClient, type GoogleAdsRow, type MerchantClient, type MerchantProduct, type MutateOperation, type ProductInput } from './types';

/**
 * Live Google Ads API (REST) + Merchant API v1. OAuth2 refresh-token flow for a user with access to
 * the StoreForge manager account (scopes: https://www.googleapis.com/auth/adwords and
 * https://www.googleapis.com/auth/content). login-customer-id = the MCC on every Ads call.
 */
export class LiveGoogle implements GoogleAdsClient, MerchantClient {
  readonly mode = 'live' as const;
  private token: { value: string; exp: number } | null = null;
  constructor(
    private readonly cfg = {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
      refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN ?? '',
      mccId: (process.env.GOOGLE_ADS_MCC_ID ?? '').replace(/-/g, ''),
      developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? '',
    },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken() {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: this.cfg.refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new GoogleAdsError(`OAuth refresh failed: ${j.error_description ?? j.error ?? res.status}`, res.status || 401, 'UNAUTHENTICATED');
    this.token = { value: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call<T>(base: 'ads' | 'merchant', method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = base === 'ads' ? `https://googleads.googleapis.com/${GOOGLE_ADS_VERSION()}/${path}` : `https://merchantapi.googleapis.com/${path}`;
    const headers: Record<string, string> = { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' };
    if (base === 'ads') {
      headers['login-customer-id'] = this.cfg.mccId;
      if (this.cfg.developerToken) headers['developer-token'] = this.cfg.developerToken; // optional since 2026-09-09
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch (e: any) {
      throw new GoogleAdsError(`Network error: ${e?.message ?? e}`, 0, 'UNAVAILABLE');
    }
    const text = await res.text();
    const j: any = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const failure = (j.error?.details ?? []).find((d: any) => Array.isArray(d.errors));
      throw new GoogleAdsError(j.error?.message ?? `HTTP ${res.status}`, res.status, j.error?.status ?? 'UNKNOWN', failure?.errors ?? [], failure?.requestId);
    }
    return j as T;
  }

  async createCustomerClient(managerId: string, o: { descriptiveName: string; currencyCode: string; timeZone: string }) {
    return this.call<{ resourceName: string }>('ads', 'POST', `customers/${managerId}:createCustomerClient`, { customerClient: o });
  }
  async search(customerId: string, query: string) {
    const out: GoogleAdsRow[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.call<{ results?: GoogleAdsRow[]; nextPageToken?: string }>('ads', 'POST', `customers/${customerId}/googleAds:search`, { query, ...(pageToken ? { pageToken } : {}) });
      out.push(...(r.results ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }
  async mutate(customerId: string, ops: MutateOperation[]) {
    return this.call<{ mutateOperationResponses: Record<string, { resourceName: string }>[] }>('ads', 'POST', `customers/${customerId}/googleAds:mutate`, { mutateOperations: ops });
  }
  async createProductLink(customerId: string, merchantCenterId: string) {
    const r = await this.call<{ resourceName: string }>('ads', 'POST', `customers/${customerId}/productLinks:create`, { productLink: { merchantCenter: { merchantCenterId } } });
    return { resourceName: r.resourceName };
  }
  async uploadConversionAdjustments(customerId: string, adjustments: ConversionAdjustment[], o: { partialFailure: true; validateOnly?: boolean }) {
    const r = await this.call<{ results?: { orderId: string }[]; partialFailureError?: { message: string } }>('ads', 'POST', `customers/${customerId}:uploadConversionAdjustments`, { conversionAdjustments: adjustments, partialFailure: o.partialFailure, validateOnly: Boolean(o.validateOnly) });
    return { results: r.results ?? [], partialFailureError: r.partialFailureError };
  }

  async createSubAccount(advancedAccountId: string, o: { accountName: string; timeZone: string; languageCode: string; websiteUrl: string }) {
    const r = await this.call<{ name: string }>('merchant', 'POST', 'accounts/v1/accounts:createAndConfigure', {
      account: { accountName: o.accountName, timeZone: { id: o.timeZone }, languageCode: o.languageCode },
      service: [{ accountAggregation: {}, provider: `accounts/${advancedAccountId}` }],
    });
    return { name: r.name, accountId: r.name.split('/')[1] };
  }
  async listSubAccounts(advancedAccountId: string) {
    const out: { name: string; accountId: string; accountName: string }[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.call<{ accounts?: { name: string; accountName: string }[]; nextPageToken?: string }>('merchant', 'GET', `accounts/v1/accounts/${advancedAccountId}:listSubaccounts?pageSize=250${pageToken ? `&pageToken=${pageToken}` : ''}`);
      for (const a of r.accounts ?? []) out.push({ name: a.name, accountId: a.name.split('/')[1], accountName: a.accountName });
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }
  async createDataSource(accountId: string, o: { displayName: string; feedLabel: string; contentLanguage: string; countries: string[] }) {
    const r = await this.call<{ name: string; dataSourceId: string }>('merchant', 'POST', `datasources/v1/accounts/${accountId}/dataSources`, {
      displayName: o.displayName, primaryProductDataSource: { contentLanguage: o.contentLanguage, feedLabel: o.feedLabel, countries: o.countries },
    });
    return { name: r.name, dataSourceId: r.dataSourceId ?? r.name.split('/').pop()! };
  }
  async insertProductInput(accountId: string, dataSource: string, input: ProductInput) {
    return this.call<{ name: string }>('merchant', 'POST', `products/v1/accounts/${accountId}/productInputs:insert?dataSource=${encodeURIComponent(dataSource)}`, input);
  }
  async listProducts(accountId: string) {
    const out: MerchantProduct[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.call<{ products?: MerchantProduct[]; nextPageToken?: string }>('merchant', 'GET', `products/v1/accounts/${accountId}/products?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`);
      out.push(...(r.products ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }
  /**
   * Accept the Ads → Merchant Center link on the MC side. NOTE: verify the exact Merchant API call on
   * the first live run (sub-accounts created under an advanced account can also be linked from the
   * advanced account's UI); the Ads side (ProductLinkService) is the documented request.
   */
  async approveAdsLink(accountId: string, adsCustomerId: string) {
    await this.call('merchant', 'POST', `accounts/v1/accounts/${accountId}/services:approve`, { provider: `accounts/${this.cfg.mccId}`, externalAccountId: adsCustomerId });
  }
}
