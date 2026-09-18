import type {
  SupplierAdapter,
  CatalogPage,
  NormalizedOrder,
  TrackingInfo,
} from '@storeforge/shared';

export class ZendropAdapter implements SupplierAdapter {
  id = 'zendrop';

  async syncCatalog(): Promise<CatalogPage> {
    return { items: [] };
  }

  async createFulfillment(_order: NormalizedOrder): Promise<{ externalId: string }> {
    throw new Error('ZendropAdapter stub — not implemented in Phase 0');
  }

  async getTracking(_externalId: string): Promise<TrackingInfo> {
    return { status: 'stub', events: [] };
  }
}
