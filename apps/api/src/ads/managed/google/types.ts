import { PlatformError } from '../types';

/**
 * Google Ads API (REST, v26 as of 2026-11) + Merchant API v1 surface used by managed Boost.
 * - Auth: OAuth2 access token from a refresh token of a user on the StoreForge manager (MCC)
 *   account; `login-customer-id: <MCC>` on every call. Access level is per Google Cloud project
 *   since developer tokens were sunset (2026-09-09); account creation needs Basic access or above.
 * - Money is micros (1 USD = 1,000,000). Customer ids are digits without dashes.
 */
export const GOOGLE_ADS_VERSION = () => process.env.GOOGLE_ADS_API_VERSION || 'v26';

export type GoogleAdsRow = {
  customerClient?: { id: string; descriptiveName: string; currencyCode: string; timeZone: string; status: string };
  customer?: { id: string; descriptiveName: string };
  campaign?: { resourceName: string; id: string; name: string; status: 'ENABLED' | 'PAUSED' | 'REMOVED'; primaryStatus?: string; primaryStatusReasons?: string[] };
  campaignBudget?: { resourceName: string; amountMicros: string };
  metrics?: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number; conversionsValue?: number };
  segments?: { date?: string };
  accountBudget?: { resourceName: string; approvedSpendingLimitMicros?: string; status: string };
  conversionAction?: { resourceName: string; id: string; name: string; tagSnippets?: { type: string; eventSnippet: string }[] };
};

/** One operation of GoogleAdsService.Mutate (only the kinds we send). */
export type MutateOperation =
  | { campaignBudgetOperation: { create?: Record<string, unknown>; update?: Record<string, unknown>; updateMask?: string } }
  | { campaignOperation: { create?: Record<string, unknown>; update?: Record<string, unknown>; updateMask?: string } }
  | { assetOperation: { create: Record<string, unknown> } }
  | { assetGroupOperation: { create: Record<string, unknown> } }
  | { assetGroupAssetOperation: { create: Record<string, unknown> } }
  | { assetGroupListingGroupFilterOperation: { create: Record<string, unknown> } }
  | { conversionActionOperation: { create: Record<string, unknown> } }
  | { accountBudgetProposalOperation: { create: Record<string, unknown> } }
  | { billingSetupOperation: { create: Record<string, unknown> } }
  | { campaignCriterionOperation: { create: Record<string, unknown> } };

export type ConversionAdjustment = {
  conversionAction: string; adjustmentType: 'ENHANCEMENT'; orderId: string;
  gclidDateTimePair?: { gclid: string; conversionDateTime: string };
  userIdentifiers: ({ hashedEmail: string } | { hashedPhoneNumber: string } | { addressInfo: Record<string, string> })[];
  userAgent?: string; adjustmentDateTime?: string;
};

export interface GoogleAdsClient {
  readonly mode: 'stub' | 'live';
  /** CustomerService.CreateCustomerClient under the MCC → "customers/1234567890" */
  createCustomerClient(managerId: string, o: { descriptiveName: string; currencyCode: string; timeZone: string }): Promise<{ resourceName: string }>;
  /** GoogleAdsService.Search (GAQL) */
  search(customerId: string, query: string): Promise<GoogleAdsRow[]>;
  /** GoogleAdsService.Mutate: atomic, temp resource names (-1, -2…) link objects within one call */
  mutate(customerId: string, ops: MutateOperation[]): Promise<{ mutateOperationResponses: Record<string, { resourceName: string }>[] }>;
  /** ProductLinkService.CreateProductLink (Ads side of the Merchant Center link) */
  createProductLink(customerId: string, merchantCenterId: string): Promise<{ resourceName: string }>;
  /** ConversionAdjustmentUploadService (enhanced conversions for web: ENHANCEMENT by order id) */
  uploadConversionAdjustments(customerId: string, adjustments: ConversionAdjustment[], o: { partialFailure: true; validateOnly?: boolean }): Promise<{ results: { orderId: string }[]; partialFailureError?: { message: string } }>;
}

export type ProductInput = {
  offerId: string; contentLanguage: string; feedLabel: string;
  productAttributes: {
    title: string; description: string; link: string; imageLink: string; availability: 'IN_STOCK' | 'OUT_OF_STOCK'; condition: 'NEW';
    price: { amountMicros: string; currencyCode: string }; brand: string; googleProductCategory?: string;
    shipping?: { country: string; price: { amountMicros: string; currencyCode: string }; minTransitDays: string; maxTransitDays: string }[];
  };
};
export type MerchantProduct = { name: string; offerId: string; productStatus?: { destinationStatuses?: { reportingContext: string; approvedCountries?: string[]; pendingCountries?: string[]; disapprovedCountries?: string[] }[]; itemLevelIssues?: { code: string; description: string; severity: string }[] } };

export interface MerchantClient {
  readonly mode: 'stub' | 'live';
  /** accounts/v1/accounts:createAndConfigure under the advanced (multi-client) account */
  createSubAccount(advancedAccountId: string, o: { accountName: string; timeZone: string; languageCode: string; websiteUrl: string }): Promise<{ name: string; accountId: string }>;
  listSubAccounts(advancedAccountId: string): Promise<{ name: string; accountId: string; accountName: string }[]>;
  /** datasources/v1/accounts/{id}/dataSources (primary API data source) */
  createDataSource(accountId: string, o: { displayName: string; feedLabel: string; contentLanguage: string; countries: string[] }): Promise<{ name: string; dataSourceId: string }>;
  /** products/v1/accounts/{id}/productInputs:insert?dataSource=… (upsert by offerId) */
  insertProductInput(accountId: string, dataSource: string, input: ProductInput): Promise<{ name: string }>;
  listProducts(accountId: string): Promise<MerchantProduct[]>;
  /** Accept the Google Ads link request on the Merchant Center side */
  approveAdsLink(accountId: string, adsCustomerId: string): Promise<void>;
}

/** Google RPC error: { error: { code, message, status, details:[{ errors:[{ errorCode, message }], requestId }] } } */
export class GoogleAdsError extends PlatformError {
  constructor(message: string, status: number, rpcStatus: string, readonly errors: { errorCode: Record<string, string>; message: string }[] = [], requestId?: string) {
    const code = errors[0] ? Object.values(errors[0].errorCode)[0] : rpcStatus;
    super(message, 'GOOGLE', {
      status, code, requestId,
      transient: ['RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'INTERNAL', 'INTERNAL_ERROR', 'TRANSIENT_ERROR'].includes(rpcStatus) || code === 'RESOURCE_TEMPORARILY_EXHAUSTED',
      auth: rpcStatus === 'UNAUTHENTICATED' || code === 'OAUTH_TOKEN_EXPIRED' || code === 'OAUTH_TOKEN_REVOKED',
      policy: errors.some((e) => 'policyFindingError' in e.errorCode || 'policyViolationError' in e.errorCode),
    });
  }
}
