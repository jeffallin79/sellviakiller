export type CatalogProduct = {
  externalId: string;
  title: string;
  description: string;
  sku: string;
  priceCents: number;
  costCents: number;
  currency: string;
  imageUrl: string;
  category: string;
  etaDaysMin: number;
  etaDaysMax: number;
  sourcingLabel: string;
  stock: number;
};

export type CatalogPage = {
  items: CatalogProduct[];
  nextCursor?: string;
};

export type NormalizedOrderLine = {
  sku: string;
  externalProductId: string;
  quantity: number;
  unitCostCents: number;
};

export type NormalizedOrder = {
  id: string;
  externalRef: string;
  shipping: {
    name: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  lines: NormalizedOrderLine[];
};

export type TrackingInfo = {
  carrier?: string;
  trackingNumber?: string;
  status: string;
  events: Array<{ at: string; status: string; description: string }>;
};

export interface SupplierAdapter {
  id: string;
  syncCatalog(cursor?: string): Promise<CatalogPage>;
  createFulfillment(order: NormalizedOrder): Promise<{ externalId: string }>;
  getTracking(externalId: string): Promise<TrackingInfo>;
}
