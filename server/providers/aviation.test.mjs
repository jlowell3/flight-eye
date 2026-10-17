import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aviationProxies,
  bearingDeg,
  distanceKm,
  nearestAirports,
  normalizeMetar,
  parseStationIds,
  parseVisibility,
} from './aviation.js';
import {
  buildAirportIndex,
  csvRecords,
  keepsAirport,
  parseCsv,
} from '../../scripts/build-airports.mjs';

const AUSTIN = { lat: 30.1975, lon: -97.662 };
const FIXTURE_AIRPORTS = [
  {
    ident: 'KAUS',
    icao: 'KAUS',
    iata: 'AUS',
    name: 'Austin Bergstrom International Airport',
    lat: 30.19754,
    lon: -97.66201,
    elevFt: 542,
    type: 'large_airport',
    runways: [{ id: '18R/36L', lengthFt: 12250 }],
    frequencies: [{ type: 'TWR', mhz: 121.0 }],
  },
  {
    ident: 'KSAT',
    icao: 'KSAT',
    iata: 'SAT',
    name: 'San Antonio International Airport',
    lat: 29.5337,
    lon: -98.4698,
    elevFt: 809,
    type: 'large_airport',
    runways: [],
    frequencies: [],
  },
  {
    ident: 'EGLL',
    icao: 'EGLL',
    iata: 'LHR',
    name: 'London Heathrow Airport',
    lat: 51.4706,
    lon: -0.461941,
    elevFt: 83,
    type: 'large_airport',
    runways: [],
    frequencies: [],
  },
];

test('station ids are upper-cased, validated, deduplicated and capped at five', () => {
  assert.deepEqual(parseStationIds('kaus, KSAT,kaus,bad,KDFW,KIAH,KHOU,KELP'), [
    'KAUS',
    'KSAT',
    'KDFW',
    'KIAH',
    'KHOU',
  ]);
  assert.deepEqual(parseStationIds(''), []);
  assert.deepEqual(parseStationIds(null), []);
});

test('visibility reads numbers and the 10+ form; METARs normalize without inventing', () => {
  assert.equal(parseVisibility('10+'), 10);
  assert.equal(parseVisibility(2.5), 2.5);
  assert.equal(parseVisibility('1/2'), null);
  assert.equal(parseVisibility(''), null);
  const metar = normalizeMetar({
    icaoId: 'kaus',
    obsTime: 1_792_000_000,
    temp: 28,
    dewp: 19,
    wdir: 170,
    wspd: 12,
    wgst: 20,
    visib: '10+',
    altim: 1013.2,
    clouds: [
      { cover: 'FEW', base: 4500 },
      { cover: 'BKN', base: 25000 },
    ],
    fltCat: 'vfr',
    rawOb: 'KAUS 180053Z 17012G20KT 10SM FEW045 BKN250 28/19 A2992',
    name: 'Austin-Bergstrom Intl, TX, US',
  });
  assert.deepEqual(metar, {
    icao: 'KAUS',
    raw: 'KAUS 180053Z 17012G20KT 10SM FEW045 BKN250 28/19 A2992',
    observedAt: new Date(1_792_000_000 * 1000).toISOString(),
    station: 'Austin-Bergstrom Intl, TX, US',
    windDirectionDeg: 170,
    windKt: 12,
    gustKt: 20,
    visibilitySm: 10,
    temperatureC: 28,
    dewpointC: 19,
    altimeterHpa: 1013.2,
    altimeterInHg: 29.92,
    clouds: [
      { cover: 'FEW', baseFt: 4500 },
      { cover: 'BKN', baseFt: 25000 },
    ],
    flightCategory: 'VFR',
  });
  const sparse = normalizeMetar({
    icaoId: 'EGLL',
    wdir: 'VRB',
    reportTime: '2026-10-18 00:50:00',
  });
  assert.equal(sparse.windDirectionDeg, 'VRB');
  assert.equal(sparse.observedAt, '2026-10-18 00:50:00');
  assert.equal(sparse.altimeterInHg, null);
  assert.deepEqual(sparse.clouds, []);
  assert.equal(normalizeMetar({ icaoId: 'bad id' }), null);
  assert.equal(normalizeMetar(null), null);
});

test('nearest airports are sorted by distance with bearing, within the radius and limit', () => {
  const near = nearestAirports(FIXTURE_AIRPORTS, {
    latitude: AUSTIN.lat + 0.3,
    longitude: AUSTIN.lon,
  });
  assert.deepEqual(
    near.map((airport) => airport.icao),
    ['KAUS'],
    'San Antonio is outside the default 80 km radius',
  );
  assert.equal(near[0].bearingDeg, 180);
  assert.ok(Math.abs(near[0].distanceKm - 33.4) < 0.5);
  assert.ok(Math.abs(near[0].distanceNm - 18) < 0.5);
  const wide = nearestAirports(FIXTURE_AIRPORTS, {
    latitude: AUSTIN.lat,
    longitude: AUSTIN.lon,
    radiusKm: 400,
    limit: 1,
  });
  assert.deepEqual(
    wide.map((airport) => airport.icao),
    ['KAUS'],
  );
  assert.equal(
    nearestAirports(FIXTURE_AIRPORTS, {
      latitude: AUSTIN.lat,
      longitude: AUSTIN.lon,
      radiusKm: 9999,
    }).length,
    2,
    'the radius is capped at 400 km',
  );
  assert.ok(Math.abs(distanceKm(0, 0, 0, 1) - 111.2) < 0.2);
  assert.equal(Math.round(bearingDeg(0, 0, 1, 0)), 0);
  assert.equal(Math.round(bearingDeg(0, 0, 0, 1)), 90);
});

test('the index keeps large, medium and scheduled small airports with runways and frequencies', () => {
  const rows = parseCsv('a,b\n"x, y","say ""hi"""\n1,2\r\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x, y', 'say "hi"'],
    ['1', '2'],
  ]);
  assert.deepEqual(csvRecords('a,b\n1,2\n'), [{ a: '1', b: '2' }]);
  assert.equal(keepsAirport({ type: 'large_airport' }), true);
  assert.equal(keepsAirport({ type: 'medium_airport' }), true);
  assert.equal(
    keepsAirport({ type: 'small_airport', scheduled_service: 'yes' }),
    true,
  );
  assert.equal(
    keepsAirport({ type: 'small_airport', scheduled_service: 'no' }),
    false,
  );
  assert.equal(
    keepsAirport({ type: 'heliport', scheduled_service: 'yes' }),
    false,
  );
  const index = buildAirportIndex({
    airports: [
      {
        ident: 'KAUS',
        type: 'large_airport',
        name: 'Austin',
        latitude_deg: '30.197535',
        longitude_deg: '-97.662015',
        elevation_ft: '542',
        iso_country: 'US',
        municipality: 'Austin',
        icao_code: 'KAUS',
        iata_code: 'AUS',
        scheduled_service: 'yes',
      },
      {
        ident: '00A',
        type: 'heliport',
        name: 'Total RF',
        latitude_deg: '40',
        longitude_deg: '-74',
      },
    ],
    runways: [
      {
        airport_ident: 'KAUS',
        length_ft: '9000',
        width_ft: '150',
        surface: 'CON',
        lighted: '1',
        closed: '0',
        le_ident: '18L',
        he_ident: '36R',
        le_heading_degT: '179',
        he_heading_degT: '359',
      },
      {
        airport_ident: 'KAUS',
        length_ft: '12250',
        closed: '0',
        le_ident: '18R',
        he_ident: '36L',
      },
      { airport_ident: 'KAUS', length_ft: '5000', closed: '1', le_ident: 'X' },
    ],
    frequencies: [
      {
        airport_ident: 'KAUS',
        type: 'TWR',
        description: 'TWR',
        frequency_mhz: '121.0',
      },
      {
        airport_ident: 'KAUS',
        type: 'MISC',
        description: 'OPS',
        frequency_mhz: '130.0',
      },
      { airport_ident: '00A', type: 'TWR', frequency_mhz: '118.0' },
    ],
  });
  assert.equal(index.length, 1);
  const [aus] = index;
  assert.equal(aus.icao, 'KAUS');
  assert.equal(aus.iata, 'AUS');
  assert.equal(aus.lat, 30.19754);
  assert.deepEqual(
    aus.runways.map((runway) => runway.id),
    ['18R/36L', '18L/36R'],
    'longest first, closed runways dropped',
  );
  assert.deepEqual(aus.runways[1].headings, [179, 359]);
  assert.deepEqual(aus.frequencies, [
    { type: 'TWR', mhz: 121, description: 'TWR' },
  ]);
});

function captureRoutes(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (path, handler) => routes.set(path, handler) },
  });
  return routes;
}

function fakeResponse() {
  const out = { statusCode: null, headers: null, body: null };
  return {
    out,
    writeHead(status, headers) {
      out.statusCode = status;
      out.headers = headers;
    },
    end(body) {
      out.body = body == null ? null : JSON.parse(body);
    },
  };
}

test('/api/metar answers decoded reports and /api/airports/nearby reads the index', async () => {
  const fetches = [];
  const routes = captureRoutes(
    aviationProxies({
      fetchImpl: async (url) => {
        fetches.push(url);
        return new Response(
          JSON.stringify([
            { icaoId: 'KAUS', wdir: 180, wspd: 10, fltCat: 'VFR' },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
      readImpl: async () =>
        JSON.stringify({ airports: FIXTURE_AIRPORTS, count: 3 }),
    }),
  );
  const metar = fakeResponse();
  await routes.get('/api/metar')(
    { method: 'GET', url: '/?ids=kaus', socket: { remoteAddress: '1.2.3.4' } },
    metar,
  );
  assert.equal(metar.out.statusCode, 200);
  assert.equal(metar.out.body.status, 'ready');
  assert.deepEqual(metar.out.body.requested, ['KAUS']);
  assert.equal(metar.out.body.metars[0].icao, 'KAUS');
  assert.equal(metar.out.body.metars[0].windKt, 10);
  assert.match(fetches[0], /ids=KAUS&format=json$/);

  const bad = fakeResponse();
  await routes.get('/api/metar')(
    { method: 'GET', url: '/?ids=', socket: { remoteAddress: '1.2.3.4' } },
    bad,
  );
  assert.equal(bad.out.statusCode, 400);

  const near = fakeResponse();
  await routes.get('/api/airports/nearby')(
    {
      method: 'GET',
      url: '/?latitude=30.5&longitude=-97.66&limit=1',
      socket: { remoteAddress: '1.2.3.4' },
    },
    near,
  );
  assert.equal(near.out.statusCode, 200);
  assert.equal(near.out.body.source, 'OurAirports');
  assert.deepEqual(
    near.out.body.airports.map((airport) => airport.icao),
    ['KAUS'],
  );
  assert.equal(typeof near.out.body.airports[0].distanceNm, 'number');

  const invalid = fakeResponse();
  await routes.get('/api/airports/nearby')(
    {
      method: 'GET',
      url: '/?latitude=x',
      socket: { remoteAddress: '1.2.3.4' },
    },
    invalid,
  );
  assert.equal(invalid.out.statusCode, 400);
});
