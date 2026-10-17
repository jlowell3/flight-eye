import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ADSB_API_BASES,
  adsbApiBases,
  adsbBaseHost,
  fetchAdsbUpstream,
  readsbAircraftList,
} from './adsb-upstreams.js';

test('the base list defaults to adsb.lol then adsb.fi and accepts an override', () => {
  assert.deepEqual(adsbApiBases({}), [...DEFAULT_ADSB_API_BASES]);
  assert.deepEqual(adsbApiBases({ ADSB_API_BASES: '' }), [
    ...DEFAULT_ADSB_API_BASES,
  ]);
  assert.deepEqual(
    adsbApiBases({
      ADSB_API_BASES:
        ' https://opendata.adsb.fi/api/ , https://api.adsb.lol, junk, https://api.adsb.lol',
    }),
    ['https://opendata.adsb.fi/api', 'https://api.adsb.lol'],
  );
  assert.deepEqual(adsbApiBases({ ADSB_API_BASES: 'junk' }), [
    ...DEFAULT_ADSB_API_BASES,
  ]);
  assert.equal(adsbBaseHost('https://api.adsb.lol'), 'adsb.lol');
  assert.equal(adsbBaseHost('https://opendata.adsb.fi/api'), 'adsb.fi');
});

test('the first usable base wins; timeouts, 429 and 5xx move to the next', async () => {
  const calls = [];
  const answers = {
    'https://one.example/v2/mil': () => {
      throw new Error('fetch failed');
    },
    'https://two.example/v2/mil': () =>
      new Response('{"error":"busy"}', { status: 429 }),
    'https://three.example/v2/mil': () =>
      new Response('{"ac":[{"hex":"abc123"}]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    'https://four.example/v2/mil': () =>
      assert.fail('a later base is not tried'),
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    return answers[url]();
  };
  const { response, base } = await fetchAdsbUpstream('/v2/mil', {
    fetchImpl,
    bases: [
      'https://one.example',
      'https://two.example',
      'https://three.example',
      'https://four.example',
    ],
  });
  assert.equal(base, 'https://three.example');
  assert.deepEqual(await response.json(), { ac: [{ hex: 'abc123' }] });
  assert.equal(calls.length, 3);
});

test('a client error other than 429 is relayed from the first base, as before', async () => {
  const { response, base } = await fetchAdsbUpstream('/v2/mil', {
    fetchImpl: async () => new Response('{"error":"bad"}', { status: 400 }),
    bases: ['https://one.example', 'https://two.example'],
  });
  assert.equal(base, 'https://one.example');
  assert.equal(response.status, 400);
});

test('when every base fails the last response or error is reported', async () => {
  const failing = await fetchAdsbUpstream('/v2/mil', {
    fetchImpl: async (url) =>
      new Response('down', { status: url.includes('one') ? 503 : 502 }),
    bases: ['https://one.example', 'https://two.example'],
  });
  assert.equal(failing.base, 'https://two.example');
  assert.equal(failing.response.status, 502);
  await assert.rejects(
    fetchAdsbUpstream('/v2/mil', {
      fetchImpl: async () => {
        throw new Error('fetch failed');
      },
      bases: ['https://one.example'],
    }),
    /fetch failed/,
  );
  await assert.rejects(
    fetchAdsbUpstream('/v2/mil', {
      fetchImpl: async () => new Response(''),
      bases: [],
    }),
    /No ADS-B upstream/,
  );
});

test('the aircraft list reads adsb.lol ac and adsb.fi aircraft alike', () => {
  assert.deepEqual(readsbAircraftList({ ac: [{ hex: 'a' }] }), [{ hex: 'a' }]);
  assert.deepEqual(
    readsbAircraftList({ aircraft: [{ hex: 'b' }], resultCount: 1 }),
    [{ hex: 'b' }],
  );
  assert.deepEqual(readsbAircraftList({}), []);
  assert.deepEqual(readsbAircraftList(null), []);
});
