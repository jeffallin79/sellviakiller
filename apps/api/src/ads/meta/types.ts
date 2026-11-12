/**
 * Meta Marketing API surface StoreForge uses ("connect your own" Boost). Shapes follow the Graph
 * API (ids like act_123, money as strings in account currency for insights, minor units for
 * budgets) so the live client is a thin HTTP layer and the stub behaves the same way.
 */
export const META_SCOPES = ['ads_management', 'ads_read', 'business_management', 'pages_show_list', 'pages_read_engagement'] as const;

export type MetaAdAccount = {
  id: string; // act_<id>
  accountId: string; // <id>
  name: string;
  currency: string;
  /** Meta account_status: 1 ACTIVE, 2 DISABLED, 3 UNSETTLED, 7 PENDING_RISK_REVIEW, 9 IN_GRACE_PERIOD, 101 CLOSED */
  accountStatus: number;
  timezone: string | null;
  businessName: string | null;
};
export type MetaPage = { id: string; name: string };
export type MetaPixel = { id: string; name: string };
export type MetaStatus = 'ACTIVE' | 'PAUSED';

/** One row of GET /{campaign}/insights?time_increment=1 (values are strings, as Meta returns them) */
export type MetaInsightRow = {
  date_start: string; // YYYY-MM-DD in the ad account's timezone
  date_stop: string;
  impressions: string;
  clicks: string;
  spend: string; // "12.34" in account currency
  actions?: { action_type: string; value: string }[];
  action_values?: { action_type: string; value: string }[];
};

/** Conversions API server event (https://developers.facebook.com/docs/marketing-api/conversions-api/parameters) */
export type CapiEvent = {
  event_name: 'Purchase' | string;
  event_time: number; // unix seconds, <= 7 days old
  event_id: string; // shared with the browser pixel's eventID for dedupe
  action_source: 'website';
  event_source_url?: string;
  user_data: {
    em?: string[]; // sha256(lowercase trimmed email)
    fn?: string[];
    ln?: string[];
    ct?: string[];
    st?: string[];
    zp?: string[];
    country?: string[];
    external_id?: string[];
    client_ip_address?: string; // never hashed
    client_user_agent?: string; // never hashed
    fbp?: string;
    fbc?: string;
  };
  custom_data?: { currency: string; value: number; content_ids?: string[]; content_type?: 'product'; num_items?: number; order_id?: string };
};
export type CapiResult = { events_received: number; messages: string[]; fbtrace_id: string };

export interface MetaMarketingClient {
  readonly mode: 'live' | 'stub';
  /** Facebook Login dialog URL */
  authorizeUrl(o: { state: string; redirectUri: string }): string;
  /** code → short-lived token → long-lived (~60 day) user token + granted scopes */
  exchangeCode(o: { code: string; redirectUri: string }): Promise<{ accessToken: string; expiresAt: Date | null; scopes: string[] }>;
  me(token: string): Promise<{ id: string; name: string }>;
  listAdAccounts(token: string): Promise<MetaAdAccount[]>;
  listPages(token: string): Promise<MetaPage[]>;
  listPixels(token: string, adAccountId: string): Promise<MetaPixel[]>;
  /** Recovers a campaign whose create call timed out (we put "[sf:<id>]" in every name) */
  findCampaignByTag(token: string, adAccountId: string, tag: string): Promise<{ id: string } | null>;
  createCampaign(token: string, adAccountId: string, o: { name: string; status: MetaStatus }): Promise<{ id: string }>;
  createAdSet(
    token: string,
    adAccountId: string,
    o: { campaignId: string; name: string; dailyBudgetMinor: number; pixelId: string; countries: string[]; status: MetaStatus },
  ): Promise<{ id: string }>;
  createCreative(
    token: string,
    adAccountId: string,
    o: { name: string; pageId: string; link: string; message: string; headline: string; imageUrl?: string | null },
  ): Promise<{ id: string }>;
  createAd(token: string, adAccountId: string, o: { name: string; adSetId: string; creativeId: string; status: MetaStatus }): Promise<{ id: string }>;
  setStatus(token: string, objectId: string, status: MetaStatus): Promise<void>;
  /** effective_status e.g. ACTIVE, PAUSED, IN_PROCESS, WITH_ISSUES, DISAPPROVED, PENDING_REVIEW */
  getCampaign(token: string, campaignId: string): Promise<{ id: string; status: string; effectiveStatus: string }>;
  insights(token: string, campaignId: string, range: { since: string; until: string }): Promise<MetaInsightRow[]>;
  sendEvents(token: string, pixelId: string, events: CapiEvent[], testEventCode?: string | null): Promise<CapiResult>;
}

/** Graph API error envelope: { error: { message, type, code, error_subcode, is_transient, fbtrace_id } } */
export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly info: { status: number; code?: number; subcode?: number; type?: string; isTransient?: boolean; fbtraceId?: string },
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
  /** Token expired / revoked / password changed → merchant must reconnect */
  get isAuth() {
    return this.info.code === 190 || this.info.code === 102 || this.info.type === 'OAuthException' && this.info.status === 401;
  }
  /** Safe to retry later (rate limits, temporary errors, 5xx, network) */
  get isTransient() {
    const c = this.info.code ?? 0;
    return Boolean(this.info.isTransient) || this.info.status >= 500 || this.info.status === 0 || [1, 2, 4, 17, 32, 341, 613, 80000, 80004].includes(c);
  }
}

export const purchasesOf = (row: MetaInsightRow) => {
  const pick = (list: { action_type: string; value: string }[] | undefined) =>
    Number(list?.find((a) => a.action_type === 'offsite_conversion.fb_pixel_purchase' || a.action_type === 'purchase')?.value ?? 0);
  return { purchases: Math.round(pick(row.actions)), revenue: pick(row.action_values) };
};
/** "12.34" (account currency) → 1234 minor units. Zero-decimal currencies are not supported in slice 3. */
export const toMinor = (s: string | number | undefined) => Math.round(Number(s ?? 0) * 100);
