import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDailyMintBudget,
  enforceDailyMintCap,
  mintBucket,
  resolveDailyMintCap,
} from './mint-budget.js';
import { createRealtimeTokenHandler } from './realtime.js';

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

function request({ remoteAddress = '10.1.1.1', headers = {} } = {}) {
  return {
    method: 'GET',
    url: '/?tier=mini',
    headers: { host: 'localhost:4173', ...headers },
    socket: { remoteAddress },
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
      this.body = String(body);
    },
  };
}

test('GEV_VOICE_DAILY_MINTS is off unless it is a positive number', () => {
  for (const off of [
    undefined,
    null,
    '',
    '  ',
    '0',
    '-3',
    'ten',
    'NaN',
    '0.0',
  ]) {
    assert.equal(resolveDailyMintCap(off), 0, String(off));
  }
  assert.equal(resolveDailyMintCap('40'), 40);
  assert.equal(resolveDailyMintCap(40), 40);
  assert.equal(resolveDailyMintCap('12.9'), 12);
  assert.equal(
    resolveDailyMintCap('0.5'),
    1,
    'a positive fraction is the strictest real cap',
  );
});

test('the budget counts per bucket per UTC day and forgets yesterday', () => {
  let at = Date.UTC(2026, 9, 17, 23, 59, 30);
  const budget = createDailyMintBudget({ cap: 2, now: () => at });
  assert.equal(budget.cap, 2);
  assert.equal(budget.allows('a'), true);
  assert.equal(budget.remaining('a'), 2);
  budget.record('a');
  assert.equal(budget.remaining('a'), 1);
  budget.record('a');
  assert.equal(budget.allows('a'), false);
  assert.equal(budget.remaining('a'), 0);
  assert.equal(budget.allows('b'), true, 'another bucket is untouched');
  assert.equal(budget.secondsUntilReset(), 30);
  at += 31_000; // past midnight UTC
  assert.equal(budget.allows('a'), true, 'a new UTC day starts afresh');
  assert.equal(budget.remaining('a'), 2);
  assert.equal(budget.secondsUntilReset(), 24 * 60 * 60 - 1);
});

test('the bucket is the app key when one is configured, else the client address', (t) => {
  env(t, 'GEV_TRUSTED_PROXY', undefined);
  assert.equal(
    mintBucket(request({ remoteAddress: '10.1.1.1' }), {}),
    'address:10.1.1.1',
  );
  assert.equal(
    mintBucket(request({ remoteAddress: '10.1.1.2' }), {}),
    'address:10.1.1.2',
  );
  assert.equal(
    mintBucket(request({ remoteAddress: '10.1.1.1' }), { GEV_APP_KEY: 'k3y' }),
    'app-key',
  );
  assert.equal(
    mintBucket(request({ remoteAddress: '10.1.1.2' }), { GEV_APP_KEY: 'k3y' }),
    'app-key',
    'every phone with the key shares one cap',
  );
  assert.equal(
    mintBucket(request(), { GEV_APP_KEY: 'k3y' }).includes('k3y'),
    false,
    'the key itself is never a map key',
  );
});

test('enforceDailyMintCap is a no-op without a budget and a 429 past the cap', () => {
  const ok = response();
  assert.equal(enforceDailyMintCap(null, 'a', ok), true);
  assert.equal(ok.statusCode, 200);
  const budget = createDailyMintBudget({
    cap: 1,
    now: () => Date.UTC(2026, 9, 17, 12),
  });
  assert.equal(enforceDailyMintCap(budget, 'a', response()), true);
  budget.record('a');
  const spent = response();
  assert.equal(enforceDailyMintCap(budget, 'a', spent), false);
  assert.equal(spent.statusCode, 429);
  assert.equal(spent.headers['content-type'], 'application/json');
  assert.equal(spent.headers['retry-after'], String(12 * 60 * 60));
  assert.deepEqual(JSON.parse(spent.body), {
    error: 'Daily voice session limit reached',
    code: 'VOICE_DAILY_CAP_REACHED',
  });
});

test('the token route stops minting after the daily cap and only counts successful mints', async (t) => {
  env(t, 'GEV_APP_KEY', undefined);
  env(t, 'GEV_TRUSTED_PROXY', undefined);
  env(t, 'GEV_RATELIMIT_OPENAI_PER_MIN', undefined);
  let at = Date.UTC(2026, 9, 17, 12);
  let upstream = 0;
  let upstreamStatus = 200;
  const handler = createRealtimeTokenHandler({
    environment: {},
    resolveApiKey: () => 'fixture-upstream-secret',
    fetchImpl: async () => {
      upstream += 1;
      return new Response(JSON.stringify({ value: 'fixture-ephemeral' }), {
        status: upstreamStatus,
        headers: { 'content-type': 'application/json' },
      });
    },
    mintBudget: createDailyMintBudget({ cap: 2, now: () => at }),
  });
  const mint = async (remoteAddress = '10.2.2.2') => {
    const res = response();
    await handler(request({ remoteAddress }), res);
    return res;
  };

  // A failed upstream mint does not spend the budget.
  upstreamStatus = 500;
  assert.equal((await mint()).statusCode, 500);
  upstreamStatus = 200;
  assert.equal((await mint()).statusCode, 200);
  assert.equal((await mint()).statusCode, 200);
  const capped = await mint();
  assert.equal(capped.statusCode, 429);
  assert.equal(JSON.parse(capped.body).code, 'VOICE_DAILY_CAP_REACHED');
  assert.equal(capped.headers['retry-after'], String(12 * 60 * 60));
  assert.equal(upstream, 3, 'a capped request never reaches OpenAI');
  assert.equal(capped.body.includes('fixture-upstream-secret'), false);

  // Without an app key the cap is per client address.
  assert.equal((await mint('10.3.3.3')).statusCode, 200);
  assert.equal(upstream, 4);

  // The next UTC day the first phone may mint again.
  at += 13 * 60 * 60 * 1000;
  assert.equal((await mint()).statusCode, 200);
  assert.equal(upstream, 5);
});

test('with an app key configured every client shares the one daily cap', async (t) => {
  env(t, 'GEV_APP_KEY', 'k3y');
  env(t, 'GEV_TRUSTED_PROXY', undefined);
  env(t, 'GEV_RATELIMIT_OPENAI_PER_MIN', undefined);
  const handler = createRealtimeTokenHandler({
    environment: {},
    resolveApiKey: () => 'fixture-upstream-secret',
    fetchImpl: async () => Response.json({ value: 'fixture-ephemeral' }),
    mintBudget: createDailyMintBudget({
      cap: 1,
      now: () => Date.UTC(2026, 9, 17, 12),
    }),
  });
  const first = response();
  await handler(request({ remoteAddress: '10.4.4.4' }), first);
  assert.equal(first.statusCode, 200);
  const second = response();
  await handler(request({ remoteAddress: '10.5.5.5' }), second);
  assert.equal(
    second.statusCode,
    429,
    'a different phone, the same app key, the same cap',
  );
});

test('mintBudget: null turns the brake off regardless of the env', async (t) => {
  env(t, 'GEV_VOICE_DAILY_MINTS', '1');
  const handler = createRealtimeTokenHandler({
    environment: {},
    resolveApiKey: () => 'fixture-upstream-secret',
    fetchImpl: async () => Response.json({ value: 'fixture-ephemeral' }),
    mintBudget: null,
  });
  for (let i = 0; i < 3; i += 1) {
    const res = response();
    await handler(request({ remoteAddress: '10.6.6.6' }), res);
    assert.equal(res.statusCode, 200);
  }
});
