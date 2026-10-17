/**
 * Vite plugin: aviation routes for Flight Eye's ATC persona and the
 * get_metar / get_nearby_airports tools (FLIGHT-EYE-PLAN.md, Phase 5).
 *
 * /api/metar?ids=KAUS,KSAT — the latest METAR for up to five stations from
 *   NOAA's Aviation Weather Center data API (keyless; attribution in
 *   DATA_SOURCES.md), normalized to the fields a controller reads, cached
 *   60 s per station set, served stale for 30 min when the upstream fails.
 * /api/airports/nearby?latitude&longitude[&radiusKm=80&limit=5] — the
 *   nearest airports from the bundled OurAirports index
 *   (src/data/local_data/ourairports/airports.json, public domain), with
 *   their runways and frequencies, bearing and distance from the point.
 */

import { readFile } from 'node:fs/promises';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { validRegionalPoint } from './regional/query.js';

const AWC_METAR_URL = 'https://aviationweather.gov/api/data/metar';
const METAR_CACHE_MS = 60_000;
const METAR_STALE_MS = 30 * 60_000;
const METAR_MAX_CACHE = 200;
const METAR_MAX_STATIONS = 5;
const METAR_MAX_RESPONSE_BYTES = 256 * 1024;
const STATION_ID = /^[A-Z0-9]{4}$/;

const AIRPORTS_URL = new URL(
  '../../src/data/local_data/ourairports/airports.json',
  import.meta.url,
);
const DEFAULT_RADIUS_KM = 80;
const MAX_RADIUS_KM = 400;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const EARTH_RADIUS_KM = 6371.0088;

const _metarCache = new Map();
const _metarInFlight = new Map();
const _rateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 45,
  globalMax: 150,
});

/** Station ids from a query value: upper-cased, deduplicated, capped. */
export function parseStationIds(value) {
  const ids = [];
  for (const part of String(value ?? '').split(',')) {
    const id = part.trim().toUpperCase();
    if (!STATION_ID.test(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= METAR_MAX_STATIONS) break;
  }
  return ids;
}

const finite = (value) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Visibility in statute miles from AWC's number or "10+" style text. */
export function parseVisibility(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  const plus = text.endsWith('+');
  const parsed = Number(plus ? text.slice(0, -1) : text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalize one AWC METAR record to what the persona reads. Unknown or
 * missing values are null; nothing is invented.
 */
export function normalizeMetar(record) {
  if (!record || typeof record !== 'object') return null;
  const icao = String(record.icaoId || '')
    .trim()
    .toUpperCase();
  if (!STATION_ID.test(icao)) return null;
  const obsTime = finite(record.obsTime);
  const altimHpa = finite(record.altim);
  const windDir = record.wdir === 'VRB' ? 'VRB' : finite(record.wdir);
  return {
    icao,
    raw: typeof record.rawOb === 'string' ? record.rawOb : null,
    observedAt:
      obsTime != null
        ? new Date(obsTime * 1000).toISOString()
        : typeof record.reportTime === 'string'
          ? record.reportTime
          : null,
    station: typeof record.name === 'string' ? record.name : null,
    windDirectionDeg: windDir,
    windKt: finite(record.wspd),
    gustKt: finite(record.wgst),
    visibilitySm: parseVisibility(record.visib),
    temperatureC: finite(record.temp),
    dewpointC: finite(record.dewp),
    altimeterHpa: altimHpa,
    altimeterInHg:
      altimHpa == null ? null : Math.round((altimHpa / 33.8639) * 100) / 100,
    clouds: Array.isArray(record.clouds)
      ? record.clouds
          .map((layer) => ({
            cover: typeof layer?.cover === 'string' ? layer.cover : null,
            baseFt: finite(layer?.base),
          }))
          .filter((layer) => layer.cover)
      : [],
    flightCategory:
      typeof record.fltCat === 'string' ? record.fltCat.toUpperCase() : null,
  };
}

async function fetchMetars(ids, fetchImpl) {
  const url = `${AWC_METAR_URL}?${new URLSearchParams({ ids: ids.join(','), format: 'json' })}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const upstream = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-flight-eye/1.0',
      },
      signal: controller.signal,
    });
    if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
    const payload = await readResponseJsonCapped(
      upstream,
      METAR_MAX_RESPONSE_BYTES,
    );
    const records = Array.isArray(payload) ? payload : [];
    return records.map(normalizeMetar).filter(Boolean);
  } finally {
    clearTimeout(timeout);
  }
}

function trimMetarCache() {
  while (_metarCache.size > METAR_MAX_CACHE) {
    const oldest = _metarCache.keys().next().value;
    if (oldest === undefined) break;
    _metarCache.delete(oldest);
  }
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in kilometres. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial true bearing from the first point to the second, 0–360. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dLon = toRadians(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * The airports within `radiusKm` of a point, nearest first, each with its
 * distance and bearing from the point.
 */
export function nearestAirports(
  airports,
  { latitude, longitude, radiusKm = DEFAULT_RADIUS_KM, limit = DEFAULT_LIMIT },
) {
  const radius = Math.min(
    MAX_RADIUS_KM,
    Number.isFinite(radiusKm) && radiusKm > 0 ? radiusKm : DEFAULT_RADIUS_KM,
  );
  const cap = Math.min(
    MAX_LIMIT,
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT,
  );
  const found = [];
  for (const airport of airports) {
    const km = distanceKm(latitude, longitude, airport.lat, airport.lon);
    if (km > radius) continue;
    found.push({
      ...airport,
      distanceKm: Math.round(km * 10) / 10,
      distanceNm: Math.round((km / 1.852) * 10) / 10,
      bearingDeg: Math.round(
        bearingDeg(latitude, longitude, airport.lat, airport.lon),
      ),
    });
  }
  found.sort((a, b) => a.distanceKm - b.distanceKm);
  return found.slice(0, cap);
}

let _airportsPromise = null;
function loadAirports(readImpl) {
  _airportsPromise ??= readImpl(AIRPORTS_URL, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed?.airports))
        throw new Error('airports.json has no airports');
      return parsed.airports;
    })
    .catch((error) => {
      _airportsPromise = null;
      throw error;
    });
  return _airportsPromise;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export function aviationProxies({
  fetchImpl = (...args) => fetch(...args),
  readImpl = readFile,
} = {}) {
  function install(middlewares) {
    middlewares.use('/api/metar', async (req, res) => {
      if (req.method !== 'GET')
        return json(res, 405, { error: 'Method Not Allowed' });
      if (!_rateLimiter(clientKey(req)))
        return json(
          res,
          429,
          { error: 'Rate limit exceeded' },
          { 'Retry-After': '10' },
        );
      const url = new URL(req.url || '', 'http://localhost');
      const ids = parseStationIds(url.searchParams.get('ids'));
      if (!ids.length)
        return json(res, 400, {
          error: 'ids must list one to five four-character station ids',
        });
      const key = ids.join(',');
      const now = Date.now();
      const cached = _metarCache.get(key);
      if (cached && now - cached.cachedAt <= METAR_CACHE_MS)
        return json(
          res,
          200,
          { ...cached.payload, status: 'cached' },
          { 'Cache-Control': 'public, max-age=30', 'X-Metar': 'HIT' },
        );
      const request = coalesceProxyRequest(_metarInFlight, key, async () => {
        const metars = await fetchMetars(ids, fetchImpl);
        const payload = {
          status: 'ready',
          retrievedAt: new Date().toISOString(),
          requested: ids,
          metars,
          source: 'NOAA Aviation Weather Center',
        };
        _metarCache.set(key, { payload, cachedAt: Date.now() });
        trimMetarCache();
        return payload;
      });
      try {
        const payload = await request.promise;
        json(res, 200, payload, {
          'Cache-Control': 'public, max-age=30',
          'X-Metar': request.shared ? 'INFLIGHT' : 'MISS',
        });
      } catch {
        if (cached && now - cached.cachedAt <= METAR_STALE_MS)
          return json(
            res,
            200,
            { ...cached.payload, status: 'stale' },
            { 'Cache-Control': 'no-store', 'X-Metar': 'STALE' },
          );
        json(
          res,
          503,
          { error: 'METAR data is temporarily unavailable' },
          { 'Cache-Control': 'no-store' },
        );
      }
    });

    middlewares.use('/api/airports/nearby', async (req, res) => {
      if (req.method !== 'GET')
        return json(res, 405, { error: 'Method Not Allowed' });
      if (!_rateLimiter(clientKey(req)))
        return json(
          res,
          429,
          { error: 'Rate limit exceeded' },
          { 'Retry-After': '10' },
        );
      const url = new URL(req.url || '', 'http://localhost');
      const point = validRegionalPoint(url.searchParams);
      if (!point)
        return json(res, 400, {
          error: 'Valid latitude and longitude are required',
        });
      let airports;
      try {
        airports = await loadAirports(readImpl);
      } catch {
        return json(res, 503, { error: 'The airport index is unavailable' });
      }
      const nearby = nearestAirports(airports, {
        latitude: point.latitude,
        longitude: point.longitude,
        radiusKm: Number(url.searchParams.get('radiusKm')),
        limit: Number(url.searchParams.get('limit')),
      });
      json(
        res,
        200,
        {
          point,
          airports: nearby,
          source: 'OurAirports',
        },
        { 'Cache-Control': 'public, max-age=300' },
      );
    });
  }
  return {
    name: 'aviation-proxies',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
