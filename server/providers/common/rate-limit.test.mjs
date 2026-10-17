import test from 'node:test';
import assert from 'node:assert/strict';
import { clientKey } from './rate-limit.js';

/** Set an env var for one test and put the old value back afterwards. */
function env(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}

const from = (remoteAddress, headers = {}) => ({
  socket: { remoteAddress },
  headers,
});

test('without GEV_TRUSTED_PROXY the bucket is the socket address and X-Forwarded-For is ignored', (t) => {
  env(t, 'GEV_TRUSTED_PROXY', undefined);
  assert.equal(clientKey(from('127.0.0.1')), '127.0.0.1');
  assert.equal(
    clientKey(from('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })),
    '127.0.0.1',
  );
  assert.equal(
    clientKey({}),
    'local',
    'no socket at all keeps the old fallback',
  );
});

test('behind a trusted proxy each forwarded client gets its own bucket', (t) => {
  env(t, 'GEV_TRUSTED_PROXY', '127.0.0.1,::1,::ffff:127.0.0.1');
  const phoneA = from('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' });
  const phoneB = from('::ffff:127.0.0.1', {
    'x-forwarded-for': '198.51.100.4, 10.0.0.1',
  });
  assert.equal(clientKey(phoneA), '203.0.113.9');
  assert.equal(
    clientKey(phoneB),
    '198.51.100.4',
    'the first entry is the client',
  );
  assert.notEqual(clientKey(phoneA), clientKey(phoneB));
  // A direct loopback request from the trusted address (no header) is itself.
  assert.equal(clientKey(from('127.0.0.1')), '127.0.0.1');
  // An untrusted peer cannot rotate its bucket by sending the header.
  assert.equal(
    clientKey(from('192.168.1.20', { 'x-forwarded-for': '203.0.113.9' })),
    '192.168.1.20',
  );
});
