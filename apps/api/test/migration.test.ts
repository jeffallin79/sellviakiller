import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@storeforge/db';

// Applies the Phase 0 baseline, inserts Phase 0-shaped Square rows, then applies the
// provider-neutral migration and checks the data survived under the new column names.
const dir = join(__dirname, '../../../packages/db/prisma/migrations');
const schema = `m_${Date.now()}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set('schema', schema);
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
after(() => db.$disconnect());

async function runSql(file: string) {
  const sql = readFileSync(join(dir, file, 'migration.sql'), 'utf8');
  for (const stmt of sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
    await db.$executeRawUnsafe(stmt);
  }
}

test('migration: Square columns renamed to provider-neutral fields without data loss', async () => {
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  await db.$executeRawUnsafe(`SET search_path TO "${schema}"`);
  await runSql('20260918000000_phase0_baseline');
  await db.$executeRawUnsafe(`INSERT INTO "Organization"(id,name,"updatedAt") VALUES ('o1','Legacy',now())`);
  await db.$executeRawUnsafe(`INSERT INTO "Plan"(id,name,"priceUsd","maxStores","maxOrdersPerMonth","squareCatalogId","updatedAt") VALUES ('starter','Starter',29,1,100,'SQ_CAT',now())`);
  await db.$executeRawUnsafe(`INSERT INTO "Subscription"(id,"organizationId","planId",status,"squareSubscriptionId","squareCustomerId","updatedAt") VALUES ('s1','o1','starter','ACTIVE','sq_sub_1','sq_cus_1',now())`);
  await db.$executeRawUnsafe(`INSERT INTO "Store"(id,"organizationId",name,slug,"updatedAt") VALUES ('st1','o1','S','legacy',now())`);
  for (const [id, pay, ord] of [['ord1', 'sq_pay_1', 'sq_ord_1'], ['ord2', 'stub_payment_x', null], ['ord3', null, null]]) {
    await db.$executeRawUnsafe(
      `INSERT INTO "Order"(id,"storeId","customerEmail","customerName","shippingLine1","shippingCity","shippingState","shippingPostalCode","subtotalCents","totalCents","squarePaymentId","squareOrderId","updatedAt") VALUES ($1,'st1','a@b.c','A','1','C','S','P',100,100,$2,$3,now())`,
      id, pay, ord,
    );
  }
  await runSql('20261112000000_provider_neutral_payments');
  const orders: any[] = await db.$queryRawUnsafe(`SELECT id, provider, "providerPaymentId", "providerCheckoutId" FROM "Order" ORDER BY id`);
  assert.deepEqual(orders.map((o) => [o.id, o.provider, o.providerPaymentId, o.providerCheckoutId]), [
    ['ord1', 'square', 'sq_pay_1', 'sq_ord_1'],
    ['ord2', 'stub', 'stub_payment_x', null],
    ['ord3', 'stub', null, null],
  ]);
  const [sub]: any[] = await db.$queryRawUnsafe(`SELECT provider, "providerSubscriptionId", "providerCustomerId" FROM "Subscription"`);
  assert.deepEqual([sub.provider, sub.providerSubscriptionId, sub.providerCustomerId], ['square', 'sq_sub_1', 'sq_cus_1']);
  const [plan]: any[] = await db.$queryRawUnsafe(`SELECT "providerPriceId" FROM "Plan"`);
  assert.equal(plan.providerPriceId, null, 'Square catalog ids cleared');
  const cols: any[] = await db.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name ILIKE '%square%'`, schema);
  assert.equal(cols.length, 0, 'no square columns remain');
});
