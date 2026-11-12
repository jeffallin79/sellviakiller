// Runs API tests in a brand-new Postgres schema (non-destructive: nothing is reset or dropped).
// Database name must end with _test. Each run gets schema t_<timestamp>, migrated from scratch
// with `prisma migrate deploy`, which also proves the migration chain applies cleanly.
import { execSync } from 'node:child_process';
const base = process.env.TEST_DATABASE_URL ?? 'postgresql://storeforge@127.0.0.1:5432/storeforge_test';
const u = new URL(base);
if (!u.pathname.slice(1).endsWith('_test')) {
  console.error(`Refusing to run tests against "${u.pathname.slice(1)}" (must end with _test)`);
  process.exit(1);
}
const schema = `t_${Date.now()}`;
u.searchParams.set('schema', schema);
const env = { ...process.env, DATABASE_URL: u.toString(), NODE_ENV: 'test', STRIPE_SECRET_KEY: '', REDIS_URL: 'redis://127.0.0.1:1' };
const run = (cmd, cwd) => execSync(cmd, { stdio: 'inherit', env, cwd });
console.log(`test schema: ${schema}`);
run('npx prisma migrate deploy', '../../packages/db');
run('node --import tsx --test --test-concurrency=1 test/*.test.ts', '.');
