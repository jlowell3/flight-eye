import test from 'node:test';
import assert from 'node:assert/strict';
import { openSkyTrackFromReadsbTrace } from './tracks.js';

test('an adsb.lol trace becomes an OpenSky track the civil client already reads', () => {
  const track = openSkyTrackFromReadsbTrace(
    {
      icao: 'abc123',
      timestamp: 1_700_000_000.5,
      trace: [
        [0, 10.5, 20.25, 'ground', 5, 90, 1, 0, null, 'adsb_icao'],
        [12.4, 10.6, 20.3, 1000, 150, 95, 0, 1200, null, 'adsb_icao'],
        [20, null, 20.4, 2000],
        'junk',
        [25, 95, 20.4, 2000],
        [30, 10.7, 20.5, null, 160, null],
      ],
    },
    'abc123',
  );
  assert.deepEqual(track, {
    icao24: 'abc123',
    callsign: null,
    startTime: 1_700_000_001,
    endTime: 1_700_000_031,
    path: [
      [1_700_000_001, 10.5, 20.25, null, 90, true],
      [1_700_000_013, 10.6, 20.3, 304.8, 95, false],
      [1_700_000_031, 10.7, 20.5, null, null, false],
    ],
  });
});

test('a trace without a base time or rows yields an empty track', () => {
  for (const payload of [null, {}, { timestamp: 'x', trace: [[0, 1, 2]] }])
    assert.deepEqual(openSkyTrackFromReadsbTrace(payload, 'abc123'), {
      icao24: 'abc123',
      callsign: null,
      startTime: null,
      endTime: null,
      path: [],
    });
});
