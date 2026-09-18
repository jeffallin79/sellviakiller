import type {
  SupplierAdapter,
  CatalogPage,
  NormalizedOrder,
  TrackingInfo,
} from '@storeforge/shared';

export class SpocketAdapter implements SupplierAdapter {
  id = 'spocket';

  async syncCatalog(): Promise<CatalogPage> {
    return { items: [] };
  }

  async createFulfillment(_order: NormalizedOrder): Promise<{ externalId: string }> {
    throw new Error('SpocketAdapter stub — not implemented in Phase 0');
  }

  async getTracking(_externalId: string): Promise<TrackingInfo> {
    return { status: 'stub', events: [] };
  }
}
