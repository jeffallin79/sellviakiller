import { Injectable } from '@nestjs/common';
import { prisma } from '@storeforge/db';

function toCsv(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return '';
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
  async productsCsv(organizationId: string, storeId?: string) {
    const items = await prisma.storeProduct.findMany({
      where: {
        store: { organizationId, ...(storeId ? { id: storeId } : {}), deletedAt: null },
        deletedAt: null,
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
      })),
    );
  }

  async ordersCsv(organizationId: string) {
    const orders = await prisma.order.findMany({
      where: { store: { organizationId } },
      include: { store: true, fulfillment: true },
      orderBy: { createdAt: 'desc' },
    });
    return toCsv(
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
