import { PrismaClient } from '@prisma/client';
import { PLANS } from '@storeforge/shared';

const prisma = new PrismaClient();

const CATEGORIES = [
  'Home & Garden',
  'Electronics',
  'Beauty',
  'Pet Supplies',
  'Sports & Outdoors',
  'Fashion Accessories',
  'Kitchen',
  'Baby',
  'Automotive',
  'Office',
];

const ADJECTIVES = [
  'Premium', 'Compact', 'Wireless', 'Eco', 'Pro', 'Ultra', 'Smart', 'Portable',
  'Deluxe', 'Minimal', 'Rugged', 'Soft', 'Classic', 'Modern', 'Essential',
];

const NOUNS = [
  'Organizer', 'Lamp', 'Charger', 'Bottle', 'Stand', 'Case', 'Mat', 'Brush',
  'Holder', 'Kit', 'Bag', 'Pillow', 'Tracker', 'Speaker', 'Clip', 'Tray',
];

function titleFor(i: number) {
  const adj = ADJECTIVES[i % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(i / ADJECTIVES.length) % NOUNS.length];
  return `${adj} ${noun} ${i + 1}`;
}

async function main() {
  const seedCount = Number(process.env.SEED_SKU_COUNT ?? 300);

  console.log('Seeding plans...');
  for (const plan of Object.values(PLANS)) {
    await prisma.plan.upsert({
      where: { id: plan.id },
      update: {
        name: plan.name,
        priceUsd: plan.priceUsd,
        maxStores: plan.maxStores,
        maxOrdersPerMonth: plan.maxOrdersPerMonth,
      },
      create: {
        id: plan.id,
        name: plan.name,
        priceUsd: plan.priceUsd,
        maxStores: plan.maxStores,
        maxOrdersPerMonth: plan.maxOrdersPerMonth,
        squareCatalogId:
          process.env[`SQUARE_PLAN_${plan.id.toUpperCase()}_ID`] || null,
      },
    });
  }

  console.log('Seeding suppliers...');
  const cj = await prisma.supplier.upsert({
    where: { code: 'cj' },
    update: { name: 'CJ Dropshipping', active: true },
    create: { code: 'cj', name: 'CJ Dropshipping', active: true },
  });
  await prisma.supplier.upsert({
    where: { code: 'spocket' },
    update: { name: 'Spocket (stub)', active: false },
    create: { code: 'spocket', name: 'Spocket (stub)', active: false },
  });
  await prisma.supplier.upsert({
    where: { code: 'zendrop' },
    update: { name: 'Zendrop (stub)', active: false },
    create: { code: 'zendrop', name: 'Zendrop (stub)', active: false },
  });

  const existing = await prisma.product.count({ where: { supplierId: cj.id } });
  if (existing >= seedCount) {
    console.log(`Catalog already has ${existing} SKUs — skip fixture seed`);
  } else {
    console.log(`Seeding ${seedCount} fixture SKUs (CJ keys not required)...`);
    const batch: Array<{
      supplierId: string;
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
    }> = [];

    for (let i = existing; i < seedCount; i++) {
      const costCents = 400 + (i % 40) * 75;
      const priceCents = Math.round(costCents * 2.2);
      const etaMin = 7 + (i % 5);
      const etaMax = etaMin + 7 + (i % 7);
      const category = CATEGORIES[i % CATEGORIES.length];
      batch.push({
        supplierId: cj.id,
        externalId: `CJ-FIX-${String(i + 1).padStart(5, '0')}`,
        title: titleFor(i),
        description: `Realistic fixture product #${i + 1}. Honest ETA ${etaMin}–${etaMax} days from supplier warehouse. Not US stock unless labeled.`,
        sku: `SF-FIX-${String(i + 1).padStart(5, '0')}`,
        priceCents,
        costCents,
        currency: 'USD',
        imageUrl: `https://picsum.photos/seed/storeforge${i}/600/600`,
        category,
        etaDaysMin: etaMin,
        etaDaysMax: etaMax,
        sourcingLabel: 'Ships from supplier warehouse (CN/EU mixed)',
        stock: 50 + (i % 200),
      });
    }

    const chunk = 100;
    for (let i = 0; i < batch.length; i += chunk) {
      const slice = batch.slice(i, i + chunk);
      await prisma.product.createMany({ data: slice, skipDuplicates: true });
      const products = await prisma.product.findMany({
        where: {
          supplierId: cj.id,
          externalId: { in: slice.map((s) => s.externalId) },
        },
      });
      await prisma.supplierProductMapping.createMany({
        data: products.map((p) => ({
          supplierId: cj.id,
          productId: p.id,
          externalSku: p.sku,
          externalVariantId: p.externalId,
        })),
        skipDuplicates: true,
      });
      console.log(`  seeded ${Math.min(i + chunk, batch.length)}/${batch.length}`);
    }
  }

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
