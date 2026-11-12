import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalIp, clientIp, effectiveHost, isTrustedPeer, parseIp, parseTrustedProxies, peerFromStamp } from '../src/lib/trusted-proxy';

test('parse IPs and CIDRs (v4, v6, mapped, junk ignored)', () => {
  assert.equal(parseIp('::ffff:10.1.2.3')?.v, 4);
  assert.equal(parseIp('[::1]')?.v, 6);
  assert.equal(parseIp('300.1.1.1'), null);
  assert.equal(parseIp('example.com'), null);
  const l = parseTrustedProxies('10.0.0.0/8, 192.168.1.5 ,fd00::/8, nonsense, 1.2.3.4/99, loopback');
  assert.equal(l.length, 5); // 10/8, 192.168.1.5, fd00::/8, loopback(2)
  assert.ok(isTrustedPeer('10.200.3.4', l));
  assert.ok(isTrustedPeer('::ffff:10.0.0.9', l));
  assert.ok(isTrustedPeer('192.168.1.5', l));
  assert.ok(!isTrustedPeer('192.168.1.6', l));
  assert.ok(isTrustedPeer('fd12:3456::1', l));
  assert.ok(!isTrustedPeer('fe80::1', l));
  assert.ok(isTrustedPeer('127.0.0.1', l) && isTrustedPeer('::1', l));
  assert.ok(!isTrustedPeer('8.8.8.8', l));
  assert.ok(!isTrustedPeer('', l) && !isTrustedPeer(null, l));
  assert.deepEqual(parseTrustedProxies(''), []);
});

test('X-Forwarded-Host only from a trusted proxy; otherwise Host', () => {
  const t = parseTrustedProxies('10.0.0.0/8');
  const h = { host: 'juniper.storeforge.local', forwardedHost: 'evil-shop.example.org' };
  assert.equal(effectiveHost({ ...h, peer: '203.0.113.9' }, t), 'juniper.storeforge.local', 'untrusted peer → Host');
  assert.equal(effectiveHost({ ...h, peer: null }, t), 'juniper.storeforge.local', 'unknown peer → Host (fail closed)');
  assert.equal(effectiveHost({ ...h, peer: '10.0.0.2' }, []), 'juniper.storeforge.local', 'empty allowlist → Host');
  assert.equal(effectiveHost({ ...h, peer: '10.0.0.2' }, t), 'evil-shop.example.org');
  assert.equal(effectiveHost({ host: 'a', forwardedHost: 'shop.one.com, shop.two.com', peer: '10.0.0.2' }, t), 'shop.one.com');
  assert.equal(effectiveHost({ host: 'a', forwardedHost: null, peer: '10.0.0.2' }, t), 'a');
});

test('peer stamp must carry this boot token (client-sent x-sf-peer is useless)', () => {
  assert.equal(peerFromStamp('10.0.0.2;tok123', 'tok123'), '10.0.0.2');
  assert.equal(peerFromStamp('::1;tok123', 'tok123'), '::1');
  assert.equal(peerFromStamp('10.0.0.2;guess', 'tok123'), null);
  assert.equal(peerFromStamp('10.0.0.2;tok123', undefined), null, 'plain next start: no token → never trusted');
  assert.equal(peerFromStamp('10.0.0.2', 'tok123'), null);
  assert.equal(peerFromStamp(null, 'tok123'), null);
});

test('client IP for CAPI: rightmost untrusted hop; client-supplied XFF on the left is ignored', () => {
  const t = parseTrustedProxies('loopback,10.0.0.0/8');
  // no stamp → unknown
  assert.equal(clientIp({ peer: null, forwardedFor: '1.2.3.4' }, t), null);
  // direct (untrusted peer): the peer, whatever XFF says
  assert.equal(clientIp({ peer: '198.51.100.7', forwardedFor: '1.2.3.4' }, t), '198.51.100.7');
  // behind Caddy on loopback: XFF last hop is the client
  assert.equal(clientIp({ peer: '127.0.0.1', forwardedFor: '203.0.113.9' }, t), '203.0.113.9');
  // spoofed prefix + LB (10.x) + Caddy: still the real client
  assert.equal(clientIp({ peer: '::1', forwardedFor: '6.6.6.6, 203.0.113.9, 10.1.2.3' }, t), '203.0.113.9');
  // everything trusted → the leftmost hop
  assert.equal(clientIp({ peer: '127.0.0.1', forwardedFor: '10.0.0.5' }, t), '10.0.0.5');
  // junk → null
  assert.equal(clientIp({ peer: '127.0.0.1', forwardedFor: 'not-an-ip' }, t), null);
});

test('QA r3 #2: every spelling of an address is normalised before trust checks and on output', () => {
  const t = parseTrustedProxies('loopback,10.0.0.0/8,fd00::/8');
  // IPv4-mapped (dotted + hex), expanded and compressed loopback → trusted like 127.0.0.1 / ::1
  for (const peer of ['::ffff:7f00:1', '::FFFF:7F00:0001', '0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '[::1]', '::ffff:0a00:0005', 'FD00:0:0:0:0:0:0:1']) assert.ok(isTrustedPeer(peer, t), peer);
  for (const peer of ['::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '::7f00:1', '2002:7f00:1::', '127.1', '0x7f.0.0.1']) assert.ok(!isTrustedPeer(peer, t), peer);
  assert.equal(canonicalIp('::ffff:a9fe:a9fe'), '169.254.169.254');
  assert.equal(canonicalIp('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(canonicalIp('0:0:0:0:0:0:0:1'), '::1');
  assert.equal(canonicalIp('2001:0DB8:0000:0000:0001:0000:0000:0001'), '2001:db8::1:0:0:1');
  assert.equal(canonicalIp('2606:4700:0:0:0:0:0:1111'), '2606:4700::1111');
  assert.equal(canonicalIp('1:0:2:3:4:5:6:7'), '1:0:2:3:4:5:6:7', 'a single zero group is not compressed');
  assert.equal(canonicalIp('::'), '::');
  // the IP handed to CAPI is canonical, whichever form the proxy wrote
  assert.equal(clientIp({ peer: '::ffff:7f00:1', forwardedFor: '::ffff:cb00:7109' }, t), '203.0.113.9');
  assert.equal(clientIp({ peer: '0:0:0:0:0:0:0:1', forwardedFor: '2606:4700:0:0:0:0:0:1111' }, t), '2606:4700::1111');
});
