import test from 'node:test';
import assert from 'node:assert/strict';
import { flightsProvider } from './opensky.js';

test('FLIGHTS_PROVIDER selects adsb.lol only when it says so', () => {
  for (const value of ['adsb-lol', 'ADSB-LOL', ' adsblol ', 'adsb.lol'])
    assert.equal(flightsProvider({ FLIGHTS_PROVIDER: value }), 'adsb-lol');
  for (const value of [undefined, '', 'opensky', 'OpenSky', 'nonsense'])
    assert.equal(flightsProvider({ FLIGHTS_PROVIDER: value }), 'opensky');
  assert.equal(flightsProvider({}), 'opensky');
  assert.equal(flightsProvider(null), 'opensky');
});
