/**
 * Managed Boost channel adapters (blueprint slice 4: MetaAdsAdapter, GoogleAdsAdapter,
 * TikTokAdsAdapter). Campaigns run in StoreForge-owned accounts, one per merchant per channel
 * (Meta Business Manager ad account / Google Ads MCC client / TikTok Business Center advertiser),
 * funded by the platform card and re-charged to the merchant's Ad Fuel as spend + ADS_FEE_PCT.
 *
 * Every adapter is the same shape over a platform client (stub or live) with that platform's own
 * API shapes. ManagedBoostService only talks to this interface.
 */
export type Channel = 'META' | 'GOOGLE' | 'TIKTOK';
export const CHANNELS: Channel[] = ['META', 'GOOGLE', 'TIKTOK'];
export const CHANNEL_LABEL: Record<Channel, string> = { META: 'Meta (Facebook & Instagram)', GOOGLE: 'Google (Performance Max)', TIKTOK: 'TikTok' };

export class PlatformError extends Error {
  constructor(message: string, readonly channel: Channel, readonly info: { status: number; code?: string | number; transient?: boolean; auth?: boolean; requestId?: string; policy?: boolean }) {
    super(message);
    this.name = 'PlatformError';
  }
  get isTransient() { return Boolean(this.info.transient) || this.info.status === 0 || this.info.status === 429 || this.info.status >= 500; }
  get isAuth() { return Boolean(this.info.auth); }
}

/** What we keep about a managed account (AdAccount columns) */
export type AccountRef = {
  externalId: string; currency: string; timezone: string | null;
  merchantCenterId?: string | null; dataSourceId?: string | null; catalogId?: string | null;
  pixelId?: string | null; pageId?: string | null; conversionActionId?: string | null; conversionTag?: string | null;
  /** Google: billing setup resource for account budgets */
  billingRef?: string | null;
};
export type ProvisionResult = Partial<AccountRef> & { externalId: string; name: string; status: 'ready' | 'pending_review' };

export type FeedProduct = {
  offerId: string; title: string; description: string; link: string; imageLink: string;
  priceMinor: number; currency: string; inStock: boolean; brand: string; category: string | null;
  etaDaysMin: number; etaDaysMax: number; shippingMinor: number; country: string;
};
export type FeedResult = { submitted: number; approved: number; pending: number; disapproved: number; issues: { offerId: string; reason: string }[]; refs?: Partial<AccountRef> };

export type LaunchInput = {
  /** "[sf:<campaignId>]" goes in every name so a timed-out create is found again, not duplicated */
  tag: string; name: string; dailyBudgetMinor: number; finalUrl: string; businessName: string;
  headlines: string[]; longHeadline: string; descriptions: string[]; primaryText: string;
  images: { ratio: string; url: string }[]; countries: string[]; offerIds: string[];
};
export type Refs = Record<string, string>;
export type InsightRow = { date: string; spendMinor: number; impressions: number; clicks: number; conversions: number; valueMinor: number };
export type DeliveryStatus = { review: 'PENDING' | 'APPROVED' | 'DISAPPROVED'; delivering: boolean; reason?: string };

/** Server-side purchase. Hashing is done by ConversionsService (sha256 of normalised values). */
export type ServerConversion = {
  eventId: string; orderId: string; eventTime: number; valueMinor: number; currency: string; sourceUrl?: string | null;
  hashed: { em?: string; ph?: string; fn?: string; ln?: string; ct?: string; st?: string; zp?: string; country?: string; external_id?: string; /** Google rules: gmail dots removed */ emGoogle?: string };
  ip?: string | null; ua?: string | null; fbp?: string | null; fbc?: string | null; gclid?: string | null; ttclid?: string | null; ttp?: string | null;
  contentIds: string[]; numItems: number;
};
export type BrowserTag = { kind: 'meta' | 'gtag' | 'tiktok'; id: string; sendTo?: string };

export interface ManagedChannel {
  readonly channel: Channel;
  readonly mode: 'stub' | 'live';
  /** Live keys present (or stub). Unconfigured channels are shown as "awaiting approval". */
  readonly configured: boolean;
  /** Find the account by key first, create it otherwise (idempotent across retries/timeouts). */
  provision(o: { key: string; storeName: string; currency: string; timezone: string; country: string; siteUrl: string }, prev: Partial<AccountRef>, save: (p: Partial<AccountRef>) => Promise<void>): Promise<ProvisionResult>;
  /** Product feed/catalog (Google Merchant Center, TikTok catalog). Meta managed uses link ads. */
  syncFeed(acct: AccountRef, products: FeedProduct[]): Promise<FeedResult>;
  /** Resumable: `refs` carries ids from earlier attempts; `save` persists each new id at once. */
  launch(acct: AccountRef, input: LaunchInput, refs: Refs, save: (refs: Refs) => Promise<void>): Promise<{ externalId: string; refs: Refs }>;
  setStatus(acct: AccountRef, externalId: string, refs: Refs, on: boolean): Promise<void>;
  setBudget(acct: AccountRef, externalId: string, refs: Refs, dailyMinor: number): Promise<void>;
  status(acct: AccountRef, externalId: string, refs: Refs): Promise<DeliveryStatus>;
  insights(acct: AccountRef, externalId: string, refs: Refs, since: string, until: string): Promise<InsightRow[]>;
  /** Lifetime spend of the whole account as the platform bills it (minor units) */
  accountSpend(acct: AccountRef): Promise<number>;
  /** Float protection: platform stops delivery once lifetime spend reaches this ceiling */
  applyCeiling(acct: AccountRef, lifetimeCapMinor: number): Promise<{ appliedMinor: number }>;
  sendConversion(acct: AccountRef, ev: ServerConversion, testCode?: string | null): Promise<{ trace: string }>;
  browserTag(acct: AccountRef): BrowserTag | null;
  /** Stub only: what the platform's test-events view would show */
  testEvents?(acct: AccountRef): { eventId: string; eventName: string; source: 'server' | 'browser'; deduplicated: boolean; receivedAt: number }[];
  /** Stub only: record a browser tag hit (storefront stub pixel) */
  recordBrowserEvent?(acct: AccountRef, eventName: string, eventId: string): void;
}

export const toMicros = (minor: number) => String(Math.round(minor) * 10_000);
export const fromMicros = (micros: string | number | undefined) => Math.round(Number(micros ?? 0) / 10_000);
