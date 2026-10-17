import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clientAddress,
  firstForwarded,
  isTrustedProxy,
  parseTrustedProxies,
} from './trusted-proxy.js';

const from = (remoteAddress, headers = {}) => ({
  socket: { remoteAddress },
  headers,
});

test('GEV_TRUSTED_PROXY parses exact addresses only', () => {
  assert.deepEqual([...parseTrustedProxies(undefined)], []);
  assert.deepEqual([...parseTrustedProxies('')], []);
  assert.deepEqual([...parseTrustedProxies(' , ,')], []);
  assert.deepEqual(
    [...parseTrustedProxies('127.0.0.1, ::1 ,::ffff:127.0.0.1')],
    ['127.0.0.1', '::1'],
    'an IPv4-mapped entry collapses onto its plain address',
  );
  assert.deepEqual([...parseTrustedProxies('10.0.0.5')], ['10.0.0.5']);
});

test("unset, no socket is a trusted proxy: today's behaviour", () => {
  for (const env of [
    {},
    { GEV_TRUSTED_PROXY: '' },
    { GEV_TRUSTED_PROXY: '  ' },
  ]) {
    assert.equal(isTrustedProxy(from('127.0.0.1'), env), false);
    assert.equal(isTrustedProxy(from('::1'), env), false);
  }
});

test('only a listed socket address is trusted, with IPv4-mapped equivalence', () => {
  const env = { GEV_TRUSTED_PROXY: '127.0.0.1,::1' };
  assert.equal(isTrustedProxy(from('127.0.0.1'), env), true);
  assert.equal(isTrustedProxy(from('::ffff:127.0.0.1'), env), true);
  assert.equal(isTrustedProxy(from('::1'), env), true);
  assert.equal(isTrustedProxy(from('10.0.0.5'), env), false, 'a LAN peer');
  assert.equal(isTrustedProxy(from(''), env), false);
  assert.equal(isTrustedProxy({}, env), false, 'no socket at all');
});

test('the trusted set follows the env value when it changes', () => {
  const req = from('10.0.0.5');
  assert.equal(isTrustedProxy(req, { GEV_TRUSTED_PROXY: '10.0.0.5' }), true);
  assert.equal(isTrustedProxy(req, { GEV_TRUSTED_PROXY: '10.0.0.6' }), false);
  assert.equal(isTrustedProxy(req, {}), false);
});

test('firstForwarded takes the client-facing value of a comma list', () => {
  assert.equal(
    firstForwarded(
      { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
      'x-forwarded-for',
    ),
    '203.0.113.9',
  );
  assert.equal(
    firstForwarded(
      { 'x-forwarded-for': ['203.0.113.9', '10.0.0.1'] },
      'x-forwarded-for',
    ),
    '203.0.113.9',
  );
  assert.equal(firstForwarded({}, 'x-forwarded-for'), '');
  assert.equal(firstForwarded(undefined, 'x-forwarded-for'), '');
});

test('clientAddress is the socket address unless a trusted proxy forwarded one', () => {
  const headers = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' };
  assert.equal(
    clientAddress(from('127.0.0.1', headers), {}),
    '127.0.0.1',
    'unset: X-Forwarded-For is client-controlled noise',
  );
  assert.equal(
    clientAddress(from('10.0.0.5', headers), {
      GEV_TRUSTED_PROXY: '127.0.0.1',
    }),
    '10.0.0.5',
    'an untrusted peer cannot spoof',
  );
  assert.equal(
    clientAddress(from('127.0.0.1', headers), {
      GEV_TRUSTED_PROXY: '127.0.0.1',
    }),
    '203.0.113.9',
  );
  assert.equal(
    clientAddress(from('127.0.0.1'), { GEV_TRUSTED_PROXY: '127.0.0.1' }),
    '127.0.0.1',
    'a trusted peer without the header is itself',
  );
  assert.equal(clientAddress(from(''), {}), '');
});
