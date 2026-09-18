import type {
  SupplierAdapter,
  CatalogPage,
  NormalizedOrder,
  TrackingInfo,
  CatalogProduct,
} from '@storeforge/shared';

/**
 * CJ Dropshipping adapter.
 * When CJ_API_KEY is missing, syncCatalog returns empty and createFulfillment is stubbed.
 */
export class CjAdapter implements SupplierAdapter {
  id = 'cj';

  private get configured() {
    return Boolean(process.env.CJ_API_KEY);
  }

  async syncCatalog(cursor?: string): Promise<CatalogPage> {
    if (!this.configured) {
      return { items: [], nextCursor: undefined };
    }
    // Real CJ API integration placeholder — flag keys in README
    // https://developers.cjdropshipping.com/
    const _cursor = cursor;
    void _cursor;
    const items: CatalogProduct[] = [];
    return { items, nextCursor: undefined };
  }

  async createFulfillment(order: NormalizedOrder): Promise<{ externalId: string }> {
    if (!this.configured) {
      // Stub: accept fulfillment locally so demo path works
      return { externalId: `CJ-STUB-${order.id.slice(-8).toUpperCase()}` };
    }
    // TODO: call CJ create order API with credentials
    return { externalId: `CJ-LIVE-${order.externalRef}` };
  }

  async getTracking(externalId: string): Promise<TrackingInfo> {
    if (externalId.startsWith('CJ-STUB-')) {
      return {
        carrier: 'YunExpress',
        trackingNumber: `YT${externalId.replace(/\W/g, '').slice(-12)}`,
        status: 'in_transit',
        events: [
          {
            at: new Date().toISOString(),
            status: 'in_transit',
            description: 'Stub tracking — set CJ_API_KEY for live updates',
          },
        ],
      };
    }
    return {
      status: 'unknown',
      events: [],
    };
  }
}
