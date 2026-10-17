import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  APP_KEY_HEADER,
  admitAppKey,
  appKeyGated,
  appKeyMatches,
  configuredAppKey,
} from './app-key.js';
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

function request({ method = 'GET', url = '/', headers = {} } = {}) {
  const req = Readable.from([]);
  Object.assign(req, {
    method,
    url,
    headers: { host: 'localhost:4173', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  });
  return req;
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

test('the header name is the one the page sends, lower-cased as Node delivers it', () => {
  assert.equal(APP_KEY_HEADER, 'x-flighteye-app-key');
});

test('unset or blank GEV_APP_KEY turns the check off', () => {
  for (const value of [undefined, '', '   ']) {
    assert.equal(configuredAppKey({ GEV_APP_KEY: value }), null);
    const res = response();
    assert.equal(admitAppKey(request(), res, { GEV_APP_KEY: value }), false);
    assert.equal(res.statusCode, 200, 'nothing written');
  }
  assert.equal(
    configuredAppKey({ GEV_APP_KEY: ' k3y ' }),
    'k3y',
    'surrounding whitespace is ignored',
  );
});

test('comparison is exact and tolerates every non-string shape', () => {
  assert.equal(appKeyMatches('k3y', 'k3y'), true);
  assert.equal(appKeyMatches('k3y ', 'k3y'), false);
  assert.equal(appKeyMatches('K3Y', 'k3y'), false);
  assert.equal(appKeyMatches('k3', 'k3y'), false, 'different lengths');
  assert.equal(appKeyMatches('', 'k3y'), false);
  assert.equal(appKeyMatches(undefined, 'k3y'), false);
  assert.equal(appKeyMatches(['k3y'], 'k3y'), false);
  assert.equal(
    appKeyMatches('k3y', null),
    false,
    'no expected key never matches',
  );
});

test('with GEV_APP_KEY set, a missing or wrong header gets 401 JSON and the right one passes', () => {
  const environment = { GEV_APP_KEY: 'k3y' };
  const missing = response();
  assert.equal(admitAppKey(request(), missing, environment), true);
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.headers['content-type'], 'application/json');
  assert.equal(missing.headers['cache-control'], 'no-store');
  assert.deepEqual(missing.body, {
    error: 'A valid app key is required',
    code: 'APP_KEY_REQUIRED',
  });

  const wrong = response();
  assert.equal(
    admitAppKey(
      request({ headers: { [APP_KEY_HEADER]: 'nope' } }),
      wrong,
      environment,
    ),
    true,
  );
  assert.equal(wrong.statusCode, 401);
  assert.equal(
    JSON.stringify(wrong.body).includes('k3y'),
    false,
    'the refusal never echoes the expected key',
  );

  const right = response();
  assert.equal(
    admitAppKey(
      request({ headers: { [APP_KEY_HEADER]: 'k3y' } }),
      right,
      environment,
    ),
    false,
  );
  assert.equal(right.statusCode, 200);
});

test('the wrapper reads process.env per request and shields the handler', (t) => {
  let calls = 0;
  const gated = appKeyGated(() => {
    calls += 1;
  });
  env(t, 'GEV_APP_KEY', undefined);
  gated(request(), response());
  assert.equal(calls, 1, 'unset: the handler runs without a header');

  env(t, 'GEV_APP_KEY', 'k3y');
  const refused = response();
  gated(request(), refused);
  assert.equal(calls, 1);
  assert.equal(refused.statusCode, 401);
  gated(request({ headers: { [APP_KEY_HEADER]: 'k3y' } }), response());
  assert.equal(calls, 2);
});

test('the installed OpenAI routes require the key only once GEV_APP_KEY is set', async (t) => {
  env(t, 'OPENAI_API_KEY', '');
  env(t, 'GEV_PREFER_CODEX_OAUTH', undefined);
  env(t, 'GEV_TRUSTED_PROXY', undefined);
  const routes = installedRoutes();
  const token = routes.get('/api/realtime/token');
  const hud = routes.get('/api/openai/hud-summary');

  env(t, 'GEV_APP_KEY', undefined);
  const openToken = response();
  await token(request({ url: '/?tier=mini' }), openToken);
  assert.equal(
    openToken.statusCode,
    503,
    'unset: straight through to the handler (no OpenAI key here)',
  );
  const openHud = response();
  await hud(request({ method: 'POST' }), openHud);
  assert.equal(openHud.statusCode, 200, 'unset: the keyless HUD answer');

  env(t, 'GEV_APP_KEY', 'k3y');
  for (const [name, route, init] of [
    ['token', token, { url: '/?tier=mini' }],
    ['hud-summary', hud, { method: 'POST' }],
  ]) {
    const missing = response();
    await route(request(init), missing);
    assert.equal(missing.statusCode, 401, `${name}: missing header`);
    assert.equal(missing.body.code, 'APP_KEY_REQUIRED');
    const wrong = response();
    await route(
      request({ ...init, headers: { [APP_KEY_HEADER]: 'nope' } }),
      wrong,
    );
    assert.equal(wrong.statusCode, 401, `${name}: wrong header`);
  }
  const rightToken = response();
  await token(
    request({
      url: '/?tier=mini',
      headers: { [APP_KEY_HEADER]: 'k3y' },
    }),
    rightToken,
  );
  assert.equal(
    rightToken.statusCode,
    503,
    'right key: the handler answers (503 without an OpenAI key)',
  );
  const rightHud = response();
  await hud(
    request({ method: 'POST', headers: { [APP_KEY_HEADER]: 'k3y' } }),
    rightHud,
  );
  assert.equal(rightHud.statusCode, 200);
  assert.equal(rightHud.body.configured, false);

  // The debug log and OAuth routes are not billed and stay as they were.
  const debugLog = routes.get('/api/realtime/debug-log');
  const log = response();
  await debugLog(request({ method: 'GET' }), log);
  assert.notEqual(log.statusCode, 401);
});
