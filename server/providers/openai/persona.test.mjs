import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeTokenHandler } from './realtime.js';
import { realtimeInstructions } from './instructions.js';
import { personaSessionInstructions } from '../../../src/voice/personas.js';

function env(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}

function request(query, { remoteAddress = '10.1.1.1', headers = {} } = {}) {
  return {
    method: 'GET',
    url: `/?${query}`,
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

function quiet(t) {
  env(t, 'GEV_APP_KEY', undefined);
  env(t, 'GEV_TRUSTED_PROXY', undefined);
  env(t, 'GEV_RATELIMIT_OPENAI_PER_MIN', '0');
  env(t, 'OPENAI_REALTIME_VOICE', undefined);
  env(t, 'OPENAI_REALTIME_VOICE_ATC', undefined);
  env(t, 'GEV_PREFER_CODEX_OAUTH', undefined);
}

function handlerCapturing(sent) {
  return createRealtimeTokenHandler({
    environment: {},
    resolveApiKey: () => 'fixture-upstream-secret',
    mintBudget: null,
    fetchImpl: async (url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ value: 'fixture-ephemeral' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

test('the session instructions start with the persona lines', () => {
  const standard = realtimeInstructions();
  assert.match(standard, /^You are GEV Voice Control/);
  const atc = realtimeInstructions(undefined, { persona: 'atc' });
  const lines = personaSessionInstructions('atc');
  assert.ok(atc.startsWith(lines.join('\n')));
  assert.ok(atc.endsWith(standard), 'the standard lines follow unchanged');
  assert.equal(realtimeInstructions(undefined, { persona: null }), standard);
});

test('a persona on the token request shapes the minted session', async (t) => {
  quiet(t);
  const sent = [];
  const handler = handlerCapturing(sent);
  const res = response();
  await handler(request('tier=mini&persona=atc'), res);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['x-gev-voice-persona'], 'atc');
  const session = sent.at(-1).session;
  assert.equal(session.audio.output.voice, 'cedar');
  assert.match(session.instructions, /^PERSONA: you are Flight Eye Control/);
  assert.match(session.instructions, /You are GEV Voice Control/);

  const plain = response();
  await handler(request('tier=mini'), plain);
  assert.equal(plain.headers['x-gev-voice-persona'], 'control');
  assert.equal(sent.at(-1).session.audio.output.voice, 'marin');
  assert.match(sent.at(-1).session.instructions, /^You are GEV Voice Control/);
});

test('the environment picks the persona voice and unknown personas are refused', async (t) => {
  quiet(t);
  env(t, 'OPENAI_REALTIME_VOICE_ATC', 'ash');
  const sent = [];
  const handler = handlerCapturing(sent);
  await handler(request('tier=standard&persona=atc'), response());
  assert.equal(sent.at(-1).session.audio.output.voice, 'ash');

  const refused = response();
  await handler(request('tier=standard&persona=pilot'), refused);
  assert.equal(refused.statusCode, 400);
  assert.deepEqual(JSON.parse(refused.body), {
    error: 'Unknown voice persona',
  });
  assert.equal(sent.length, 1, 'nothing was minted for the unknown persona');
});
