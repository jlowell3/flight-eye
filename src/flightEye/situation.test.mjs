import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  SITUATION_EVENT_TYPE,
  clockPosition,
  composeSituation,
  createSituationFeed,
  flightLevel,
  phaseOfFlight,
} from './situation.js';

const TRACKED = {
  icao24: 'a46e35',
  callsign: 'DAL2534',
  registration: 'N123DL',
  typeName: 'Boeing 737-900',
  airline: 'Delta',
  latitude: 30.5,
  longitude: -97.7,
  altitudeM: 10668,
  velocityMps: 230,
  track: 90,
  verticalRateMps: -4,
  squawk: '2345',
  origin: 'ATL',
  destination: 'LAX',
  onGround: false,
  stale: false,
};

test('phase of flight, flight levels and clock positions', () => {
  assert.equal(
    phaseOfFlight({ onGround: true, altitudeFt: 0, verticalRateFpm: 0 }),
    'on the ground',
  );
  assert.equal(
    phaseOfFlight({ altitudeFt: 5000, verticalRateFpm: 900 }),
    'climbing',
  );
  assert.equal(
    phaseOfFlight({ altitudeFt: 30000, verticalRateFpm: -1200 }),
    'descending',
  );
  assert.equal(
    phaseOfFlight({ altitudeFt: 35000, verticalRateFpm: 50 }),
    'cruising',
  );
  assert.equal(
    phaseOfFlight({ altitudeFt: 3000, verticalRateFpm: null }),
    'level',
  );
  assert.equal(flightLevel(35000), 'FL350');
  assert.equal(flightLevel(17900), null);
  assert.equal(flightLevel(null), null);
  assert.equal(clockPosition(0), "twelve o'clock");
  assert.equal(clockPosition(45), "two o'clock");
  assert.equal(clockPosition(-90), "nine o'clock");
  assert.equal(clockPosition(179), "six o'clock");
  assert.equal(clockPosition(null), null);
});

test('the situation item describes the aircraft, contacts, airports and METAR in aviation units', () => {
  const item = composeSituation({
    tracked: TRACKED,
    contacts: [
      {
        icao24: 'a46e35',
        callsign: 'DAL2534',
        lat: 30.5,
        lon: -97.7,
        distanceM: 0,
      },
      {
        icao24: 'abc001',
        callsign: 'UAL1',
        aircraftClass: 'airliner',
        lat: 30.5,
        lon: -97.5,
        distanceM: 19_000,
        altitudeM: 11_278,
        track: 270,
      },
      {
        icao24: 'abc002',
        callsign: null,
        lat: 30.7,
        lon: -97.7,
        distanceM: 22_000,
        altitudeM: null,
      },
    ],
    airports: [
      {
        icao: 'KAUS',
        iata: 'AUS',
        name: 'Austin',
        distanceNm: 18.2,
        bearingDeg: 180,
        elevFt: 542,
        runways: [{ id: '18R/36L', lengthFt: 12250 }, { id: 'H1' }],
        frequencies: [
          { type: 'TWR', mhz: 121 },
          { type: 'ATIS', mhz: 124.4 },
        ],
      },
    ],
    metar: {
      icao: 'KAUS',
      raw: 'KAUS 180053Z 17012G20KT 10SM FEW045 28/19 A2992',
      observedAt: '2026-10-18T00:53:00.000Z',
      windDirectionDeg: 170,
      windKt: 12,
      gustKt: 20,
      visibilitySm: 10,
      clouds: [{ cover: 'FEW', baseFt: 4500 }],
      temperatureC: 28,
      dewpointC: 19,
      altimeterInHg: 29.92,
      altimeterHpa: 1013.2,
      flightCategory: 'VFR',
    },
    now: Date.UTC(2026, 9, 18, 1),
  });
  assert.equal(item.type, SITUATION_EVENT_TYPE);
  assert.equal(item.at, '2026-10-18T01:00:00.000Z');
  assert.equal(item.simulation, true);
  assert.deepEqual(item.aircraft, {
    callsign: 'DAL2534',
    icao24: 'a46e35',
    registration: 'N123DL',
    type: 'Boeing 737-900',
    airline: 'Delta',
    altitude_ft: 35000,
    flight_level: 'FL350',
    heading_deg: 90,
    ground_speed_kt: 447,
    vertical_rate_fpm: -787,
    squawk: '2345',
    emergency: null,
    on_ground: false,
    phase: 'descending',
    route: { origin: 'ATL', destination: 'LAX' },
    position: { lat: 30.5, lon: -97.7 },
    stale: false,
  });
  assert.equal(
    item.contacts.length,
    2,
    'the tracked aircraft is not its own contact',
  );
  const [ahead, north] = item.contacts;
  assert.equal(ahead.callsign, 'UAL1');
  assert.equal(ahead.bearing_deg, 90);
  assert.equal(ahead.relative_bearing_deg, 0);
  assert.equal(ahead.clock_position, "twelve o'clock");
  assert.equal(ahead.distance_nm, 10.3);
  assert.equal(ahead.altitude_ft, 37001);
  assert.equal(ahead.altitude_delta_ft, 2001);
  assert.equal(ahead.heading_deg, 270);
  assert.equal(north.callsign, 'abc002');
  assert.equal(north.bearing_deg, 0);
  assert.equal(north.relative_bearing_deg, -90);
  assert.equal(north.clock_position, "nine o'clock");
  assert.equal(north.altitude_ft, null);
  assert.equal(north.altitude_delta_ft, null);
  assert.deepEqual(item.airports, [
    {
      icao: 'KAUS',
      iata: 'AUS',
      name: 'Austin',
      distance_nm: 18.2,
      bearing_deg: 180,
      elevation_ft: 542,
      runways: ['18R/36L 12250 ft', 'H1'],
      frequencies: { TWR: 121, ATIS: 124.4 },
    },
  ]);
  assert.equal(item.metar.wind, '170 at 12 kt gusting 20');
  assert.deepEqual(item.metar.clouds, ['FEW 4500 ft']);
  assert.equal(item.metar.altimeter_inhg, 29.92);
  assert.equal(item.metar.flight_category, 'VFR');
  assert.equal(composeSituation({ tracked: null }), null);
  const bare = composeSituation({
    tracked: { icao24: 'abc123', onGround: true },
  });
  assert.equal(bare.aircraft.phase, 'on the ground');
  assert.equal(bare.aircraft.altitude_ft, 0);
  assert.equal(bare.aircraft.route, null);
  assert.equal(bare.metar, null);
});

test('the feed sends only while a session listens and an aircraft is tracked', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sent = [];
  let active = false;
  let listeners = [];
  let tracked = null;
  const flights = {
    getTrackedInfo: () => tracked,
    getNearby: (center, range, limit) => [
      {
        icao24: 'abc001',
        callsign: 'UAL1',
        position: Cesium.Cartesian3.fromDegrees(-97.5, 30.5, 11_000),
        distance: 19_000,
        altitudeM: 11_000,
        track: 270,
      },
    ],
  };
  const military = { getTrackedInfo: () => null, getNearby: () => [] };
  const calls = { airports: 0, metar: 0 };
  const application = {
    getComponents: () => ({
      data: {
        dataManager: {
          layers: new Map([
            ['flights', { module: flights }],
            ['military', { module: military }],
          ]),
        },
      },
      scene: {
        operations: {
          requests: {
            aviation: {
              nearbyAirports: async () => {
                calls.airports++;
                return {
                  airports: [
                    {
                      icao: 'KAUS',
                      name: 'Austin',
                      distanceNm: 18,
                      bearingDeg: 180,
                      elevFt: 542,
                      runways: [],
                      frequencies: [],
                    },
                  ],
                };
              },
              getMetar: async () => {
                calls.metar++;
                return {
                  metars: [
                    {
                      icao: 'KAUS',
                      windDirectionDeg: 180,
                      windKt: 8,
                      clouds: [],
                    },
                  ],
                };
              },
            },
          },
        },
      },
      tools: {
        voiceCommands: {
          session: {
            isActive: () => active,
            sendMapEvent: (event) => {
              sent.push(event);
              return true;
            },
            subscribe: (listener) => {
              listeners.push(listener);
              return () => {
                listeners = listeners.filter((entry) => entry !== listener);
              };
            },
          },
        },
      },
    }),
  };
  let clock = Date.UTC(2026, 9, 18, 1);
  const feed = createSituationFeed({ application, now: () => clock });
  assert.ok(feed);
  assert.equal(await feed.tick(), false, 'idle session: nothing sent');
  active = true;
  assert.equal(await feed.tick(), false, 'nothing tracked: nothing sent');
  tracked = TRACKED;
  assert.equal(await feed.tick(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, SITUATION_EVENT_TYPE);
  assert.equal(sent[0].contacts[0].callsign, 'UAL1');
  assert.equal(sent[0].airports[0].icao, 'KAUS');
  assert.equal(sent[0].metar.icao, 'KAUS');
  assert.deepEqual(calls, { airports: 1, metar: 1 });
  // A listening state starts a tick; airports and METARs stay cached.
  for (const listener of listeners)
    listener({ type: 'state', state: 'listening' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.deepEqual(calls, { airports: 1, metar: 1 });
  // The interval ticks too.
  clock += 15_000;
  t.mock.timers.tick(15_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 3);
  feed.destroy();
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 3, 'destroyed feeds stop');
  assert.equal(listeners.length, 0);
});
