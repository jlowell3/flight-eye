import test from 'node:test';
import assert from 'node:assert/strict';
import { admitSameSite, sameSiteGated } from './same-site.js';
import { openAiRealtimeProxy } from '../openai.js';

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

/** What the preview server sees when Caddy forwards a phone's request. */
function caddyRequest(overrides = {}) {
  return {
    method: 'GET',
    url: '/?tier=mini',
    headers: {
      host: 'flight-eye.example',
      origin: 'https://flight-eye.example',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'flight-eye.example',
      ...overrides,
    },
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
    on() {},
  };
}

function response() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    body: undefined,
    setHeader(name, value) {
      headers[name.toLowerCase()] = String(value);
    },
    end(body = '') {
      this.body = body ? JSON.parse(String(body)) : null;
    },
  };
}

function installedRoutes() {
  const routes = new Map();
  openAiRealtimeProxy().configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return routes;
}

test('without GEV_TRUSTED_PROXY a Caddy-style request is refused as today', (t) => {
  env(t, 'GEV_TRUSTED_PROXY', undefined);
  const res = response();
  assert.equal(admitSameSite(caddyRequest(), res), true);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Proxied requests are not accepted');
});

test('with GEV_TRUSTED_PROXY naming the loopback peer the same request is admitted', (t) => {
  env(t, 'GEV_TRUSTED_PROXY', '127.0.0.1,::1,::ffff:127.0.0.1');
  const res = response();
  assert.equal(admitSameSite(caddyRequest(), res), false);
  assert.equal(res.statusCode, 200, 'nothing was written');
  // A foreign Origin is still refused: trust changes which headers describe
  // the request, not what the request must satisfy.
  const foreign = response();
  assert.equal(
    admitSameSite(caddyRequest({ origin: 'https://evil.example' }), foreign),
    true,
  );
  assert.equal(foreign.statusCode, 403);
});

test('a trusted-proxy entry does not trust other peers', (t) => {
  env(t, 'GEV_TRUSTED_PROXY', '127.0.0.1');
  const req = caddyRequest();
  req.socket.remoteAddress = '192.168.1.20';
  const res = response();
  assert.equal(
    admitSameSite(req, res),
    true,
    'a LAN peer sending forwarding headers is still refused',
  );
  assert.equal(res.statusCode, 403);
});

test('the wrapper hands admitted requests to the handler and refused ones never reach it', (t) => {
  env(t, 'GEV_TRUSTED_PROXY', '127.0.0.1');
  let calls = 0;
  const gated = sameSiteGated(() => {
    calls += 1;
  });
  gated(caddyRequest(), response());
  assert.equal(calls, 1);
  const refused = response();
  gated(caddyRequest({ 'sec-fetch-site': 'cross-site' }), refused);
  assert.equal(calls, 1);
  assert.equal(refused.statusCode, 403);
});

test('the installed /api/realtime/token route admits a forwarded request only when the proxy is trusted', async (t) => {
  env(t, 'OPENAI_API_KEY', '');
  env(t, 'GEV_APP_KEY', undefined);
  env(t, 'GEV_PREFER_CODEX_OAUTH', undefined);
  const token = installedRoutes().get('/api/realtime/token');

  env(t, 'GEV_TRUSTED_PROXY', undefined);
  const refused = response();
  await token(caddyRequest(), refused);
  assert.equal(refused.statusCode, 403);

  env(t, 'GEV_TRUSTED_PROXY', '127.0.0.1,::1,::ffff:127.0.0.1');
  const admitted = response();
  await token(caddyRequest(), admitted);
  // Past the gate: the handler itself answers, here 503 for a server with no key.
  assert.equal(admitted.statusCode, 503);
  assert.equal(admitted.body.error, 'OPENAI_API_KEY is not set');
});
