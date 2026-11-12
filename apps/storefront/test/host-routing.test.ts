import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHost, decide, shopHref, hostnameOf } from '../src/lib/host-routing';

const R = 'storeforge.local';

test('classifyHost', () => {
  assert.deepEqual(classifyHost('demo.storeforge.local:3000', R), { kind: 'subdomain', slug: 'demo' });
  assert.deepEqual(classifyHost('Demo.StoreForge.Local.', R), { kind: 'subdomain', slug: 'demo' });
  assert.deepEqual(classifyHost('demo.localhost:3000', R), { kind: 'subdomain', slug: 'demo' });
  for (const h of ['storeforge.local', 'www.storeforge.local', 'admin.storeforge.local', 'localhost:3000', '127.0.0.1:3000', '[::1]:3000', '', null, 'a.b.storeforge.local']) {
    assert.deepEqual(classifyHost(h, R), { kind: 'platform' }, String(h));
  }
  assert.deepEqual(classifyHost('Shop.Juniper.com:443', R), { kind: 'custom', host: 'shop.juniper.com' });
  assert.equal(hostnameOf('X.com.:8080'), 'x.com');
});

test('platform host: path mode, base from path', () => {
  assert.deepEqual(decide({ kind: 'platform' }, '/s/demo/p/1', '', undefined), { action: 'next', base: '/s/demo' });
  assert.deepEqual(decide({ kind: 'platform' }, '/', '', undefined), { action: 'next', base: '' });
});

test('subdomain: rewrite to /s/slug; global paths untouched; custom-domain redirect; API down still serves', () => {
  const c = { kind: 'subdomain', slug: 'demo' } as const;
  const ok = { slug: 'demo', kind: 'subdomain' } as const;
  assert.deepEqual(decide(c, '/', '', ok), { action: 'rewrite', pathname: '/s/demo', base: '' });
  assert.deepEqual(decide(c, '/p/abc', '?x=1', ok), { action: 'rewrite', pathname: '/s/demo/p/abc', base: '' });
  assert.deepEqual(decide(c, '/checkout/complete', '', ok), { action: 'next', base: '' });
  assert.deepEqual(decide(c, '/s/demo/p/1', '', ok), { action: 'next', base: '/s/demo' });
  assert.deepEqual(decide(c, '/p/1', '?a=b', { ...ok, redirectTo: 'shop.juniper.com' }), { action: 'redirect', location: 'https://shop.juniper.com/p/1?a=b', status: 308 });
  assert.deepEqual(decide(c, '/s/demo/p/1', '', { ...ok, redirectTo: 'shop.juniper.com' }), { action: 'redirect', location: 'https://shop.juniper.com/p/1', status: 308 });
  assert.deepEqual(decide(c, '/p/1', '', 'error'), { action: 'rewrite', pathname: '/s/demo/p/1', base: '' });
  assert.deepEqual(decide(c, '/', '', null), { action: 'rewrite', pathname: '/s/demo', base: '' });
});

test('custom domain: active → rewrite; unknown/unverified → 404 page; API down → 503; canonical redirects', () => {
  const c = { kind: 'custom', host: 'shop.juniper.com' } as const;
  const ok = { slug: 'juniper', kind: 'custom' } as const;
  assert.deepEqual(decide(c, '/', '', ok), { action: 'rewrite', pathname: '/s/juniper', base: '' });
  assert.deepEqual(decide(c, '/p/42', '', ok), { action: 'rewrite', pathname: '/s/juniper/p/42', base: '' });
  assert.deepEqual(decide(c, '/checkout/complete', '?orderId=1', ok), { action: 'next', base: '' });
  assert.deepEqual(decide(c, '/s/juniper/p/42', '?q=1', ok), { action: 'redirect', location: 'https://shop.juniper.com/p/42?q=1', status: 308 });
  assert.deepEqual(decide(c, '/s/juniper', '', ok), { action: 'redirect', location: 'https://shop.juniper.com/', status: 308 });
  assert.deepEqual(decide(c, '/s/other-shop', '', ok), { action: 'unknown', host: 'shop.juniper.com', status: 404 }, "can't browse other shops via this domain");
  assert.deepEqual(decide(c, '/p/1', '', { ...ok, redirectTo: 'www.juniper.com' }), { action: 'redirect', location: 'https://www.juniper.com/p/1', status: 308 });
  assert.deepEqual(decide(c, '/', '', null), { action: 'unknown', host: 'shop.juniper.com', status: 404 });
  assert.deepEqual(decide(c, '/', '', 'error'), { action: 'unknown', host: 'shop.juniper.com', status: 503 });
});

test('shopHref', () => {
  assert.equal(shopHref('', '/'), '/');
  assert.equal(shopHref('', '/p/1'), '/p/1');
  assert.equal(shopHref('', '#shelf'), '/#shelf');
  assert.equal(shopHref('/s/demo', '/'), '/s/demo');
  assert.equal(shopHref('/s/demo', '/p/1'), '/s/demo/p/1');
  assert.equal(shopHref('/s/demo', '#shelf'), '/s/demo#shelf');
  assert.equal(shopHref('/s/demo', 'p/1'), '/s/demo/p/1');
});
