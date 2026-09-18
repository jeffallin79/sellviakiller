import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@storeforge/db';
import type { ImportProductsInput } from '@storeforge/shared';
import { SuppliersService } from '../suppliers/suppliers.service';

@Injectable()
export class CatalogService {
  constructor(private readonly suppliers: SuppliersService) {}

  async listProducts(opts: { q?: string; category?: string; take?: number; skip?: number }) {
    const take = Math.min(opts.take ?? 50, 100);
    const skip = opts.skip ?? 0;
    const where = {
      active: true,
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.q
        ? {
            OR: [
              { title: { contains: opts.q, mode: 'insensitive' as const } },
              { sku: { contains: opts.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        take,
        skip,
        orderBy: { createdAt: 'asc' },
        include: { supplier: true },
      }),
      prisma.product.count({ where }),
    ]);
    return { items, total, take, skip };
  }

  async syncFromSupplier(supplierCode = 'cj') {
    const supplier = await prisma.supplier.findUnique({ where: { code: supplierCode } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    const adapter = this.suppliers.get(supplierCode);
    const page = await adapter.syncCatalog();
    let upserted = 0;
    for (const item of page.items) {
      const product = await prisma.product.upsert({
        where: {
          supplierId_externalId: {
            supplierId: supplier.id,
            externalId: item.externalId,
          },
        },
        update: {
          title: item.title,
          description: item.description,
          sku: item.sku,
          priceCents: item.priceCents,
          costCents: item.costCents,
          imageUrl: item.imageUrl,
          category: item.category,
          etaDaysMin: item.etaDaysMin,
          etaDaysMax: item.etaDaysMax,
          sourcingLabel: item.sourcingLabel,
          stock: item.stock,
        },
        create: {
          supplierId: supplier.id,
          externalId: item.externalId,
          title: item.title,
          description: item.description,
          sku: item.sku,
          priceCents: item.priceCents,
          costCents: item.costCents,
          imageUrl: item.imageUrl,
          category: item.category,
          etaDaysMin: item.etaDaysMin,
          etaDaysMax: item.etaDaysMax,
          sourcingLabel: item.sourcingLabel,
          stock: item.stock,
        },
      });
      await prisma.supplierProductMapping.upsert({
        where: {
          supplierId_productId: { supplierId: supplier.id, productId: product.id },
        },
        update: { externalSku: item.sku },
        create: {
          supplierId: supplier.id,
          productId: product.id,
          externalSku: item.sku,
          externalVariantId: item.externalId,
        },
      });
      upserted++;
    }
    return {
      upserted,
      nextCursor: page.nextCursor,
      note: process.env.CJ_API_KEY
        ? 'Live CJ sync'
        : 'CJ_API_KEY missing — use pnpm db:seed fixtures (USE_CATALOG_FIXTURES=true)',
    };
  }

  async importToStore(storeId: string, input: ImportProductsInput) {
    const products = await prisma.product.findMany({
      where: { id: { in: input.productIds }, active: true },
    });
    if (products.length === 0) throw new NotFoundException('No products found');

    const created = [];
    for (const p of products) {
      const priceCents = Math.round(p.costCents * (1 + input.markupPercent / 100));
      const sp = await prisma.storeProduct.upsert({
        where: { storeId_productId: { storeId, productId: p.id } },
        update: {
          priceCents,
          active: true,
          deletedAt: null,
          title: p.title,
        },
        create: {
          storeId,
          productId: p.id,
          title: p.title,
          priceCents,
          active: true,
        },
      });
      created.push(sp);
    }
    return { imported: created.length, items: created };
  }

  async listStoreProducts(storeIdOrSlug: string) {
    const store = await prisma.store.findFirst({
      where: {
        OR: [{ id: storeIdOrSlug }, { slug: storeIdOrSlug }],
        deletedAt: null,
      },
    });
    if (!store) throw new NotFoundException('Store not found');
    return prisma.storeProduct.findMany({
      where: { storeId: store.id, active: true, deletedAt: null },
      include: { product: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}
