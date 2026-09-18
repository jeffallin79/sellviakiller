import { Injectable } from '@nestjs/common';
import { prisma } from '@storeforge/db';

function toCsv(rows: Record<string, unknown>[]) {
  if (rows.length === 0) {
    // Always emit a header row so exports aren't 0-byte after soft-delete edge cases
    return 'storeSlug,sku,title,priceCents,costCents,etaDaysMin,etaDaysMax,sourcingLabel,active,storeDeleted\n';
  }
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\n');
}

function toOrdersCsv(rows: Record<string, unknown>[]) {
  if (rows.length === 0) {
    return 'orderId,storeSlug,status,customerEmail,totalCents,trackingNumber,carrier,createdAt\n';
  }
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\n');
}

@Injectable()
export class ExportService {
  /**
   * Export store products for the org.
   * Includes products on soft-deleted stores (Sellvia pain: keep data exportable).
   * Excludes only StoreProduct rows that were themselves soft-deleted.
   */
  async productsCsv(organizationId: string, storeId?: string) {
    const items = await prisma.storeProduct.findMany({
      where: {
        deletedAt: null,
        store: {
          organizationId,
          ...(storeId ? { id: storeId } : {}),
          // Intentionally do NOT require store.deletedAt: null — soft-deleted
          // stores must remain exportable.
        },
      },
      include: { product: true, store: true },
    });
    return toCsv(
      items.map((sp) => ({
        storeSlug: sp.store.slug,
        sku: sp.product.sku,
        title: sp.title ?? sp.product.title,
        priceCents: sp.priceCents,
        costCents: sp.product.costCents,
        etaDaysMin: sp.product.etaDaysMin,
        etaDaysMax: sp.product.etaDaysMax,
        sourcingLabel: sp.product.sourcingLabel,
        active: sp.active,
        storeDeleted: sp.store.deletedAt ? 'true' : 'false',
      })),
    );
  }

  async ordersCsv(organizationId: string) {
    const orders = await prisma.order.findMany({
      where: { store: { organizationId } },
      include: { store: true, fulfillment: true },
      orderBy: { createdAt: 'desc' },
    });
    return toOrdersCsv(
      orders.map((o) => ({
        orderId: o.id,
        storeSlug: o.store.slug,
        status: o.status,
        customerEmail: o.customerEmail,
        totalCents: o.totalCents,
        trackingNumber: o.fulfillment?.trackingNumber ?? '',
        carrier: o.fulfillment?.carrier ?? '',
        createdAt: o.createdAt.toISOString(),
      })),
    );
  }
}
