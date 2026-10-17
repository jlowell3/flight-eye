import { flightsProvider, getOpenSkyToken } from './opensky.js';
import { readCappedResponseText } from '../common/http.js';
/**
 * Vite plugin: aircraft track-history backfill proxies (PRD WS-F F1/F2).
 *
 * /api/flights/track?icao24=<hex6> — OpenSky GET /tracks/all (experimental;
 *   own credit bucket, 4 credits per call on the free tier). OAuth via the
 *   shared coalesced token. 60s per-icao cache; 404/429 forwarded so the
 *   client can fall back to its accumulated trail silently. Under
 *   FLIGHTS_PROVIDER=adsb-lol the same route serves the aircraft's adsb.lol
 *   trace rewritten into OpenSky's shape, so the client reads one format.
 * /api/military/track?hex=<hex> — adsb.lol tar1090 readsb trace
 *   (undocumented but live; no browser CORS, hence this proxy). Up to ~24h
 *   of real history per aircraft. Treat as best-effort; data is ODbL —
 *   credit "adsb.lol (ODbL)" in the UI.
 */

const FEET_TO_METRES = 0.3048;

/** A finite number from a trace cell; null, booleans and blanks are not 0. */
const cell = (value) =>
  typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;

const readsbTraceUrl = (hex) =>
  `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`;

/**
 * An OpenSky /tracks/all body built from an adsb.lol readsb trace. OpenSky
 * rows are [time s, lat, lon, baro alt m, true track, on ground]; readsb
 * rows are [offset s from `timestamp`, lat, lon, alt ft or 'ground', ground
 * speed, track, ...]. Rows without a finite position are dropped; altitude
 * is null on the ground or when unreported.
 */
export function openSkyTrackFromReadsbTrace(payload, icao24) {
  const base = Number(payload?.timestamp);
  const rows =
    Number.isFinite(base) && Array.isArray(payload?.trace) ? payload.trace : [];
  const path = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const offset = cell(row[0]);
    const latitude = cell(row[1]);
    const longitude = cell(row[2]);
    if (![offset, latitude, longitude].every(Number.isFinite)) continue;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    const onGround =
      typeof row[3] === 'string' && row[3].trim().toLowerCase() === 'ground';
    const altitudeFt = onGround ? NaN : cell(row[3]);
    const track = cell(row[5]);
    path.push([
      Math.round(base + offset),
      latitude,
      longitude,
      Number.isFinite(altitudeFt)
        ? Math.round(altitudeFt * FEET_TO_METRES * 100) / 100
        : null,
      Number.isFinite(track) ? track : null,
      onGround,
    ]);
  }
  return {
    icao24,
    callsign: null,
    startTime: path.length ? path[0][0] : null,
    endTime: path.length ? path[path.length - 1][0] : null,
    path,
  };
}

export function trackBackfillProxies() {
  const TRACK_CACHE_MS = 60000;
  const TRACK_CACHE_MAX = 200;
  const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;
  /** @type {Map<string, {at:number,status:number,body:string}>} */
  const cache = new Map();

  function cachePut(key, entry) {
    cache.set(key, entry);
    if (cache.size > TRACK_CACHE_MAX) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
  }

  /** `transform` rewrites an OK body before it is cached and served. */
  async function proxyJson(res, key, upstreamUrl, headers = {}, transform) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < TRACK_CACHE_MS) {
      res.statusCode = cached.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(cached.body);
      return;
    }
    const upstream = await fetch(upstreamUrl, {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    const { tooLarge, text } = await readCappedResponseText(
      upstream,
      RESPONSE_CAP_BYTES,
    );
    let body;
    let status = upstream.status;
    if (tooLarge) {
      status = 502;
      body = JSON.stringify({ error: 'Upstream track response too large' });
    } else if (!upstream.ok) {
      // Sanitize upstream error surface; status code is signal enough
      body = JSON.stringify({ error: `Track source HTTP ${upstream.status}` });
    } else if (transform) {
      try {
        body = transform(text);
      } catch {
        status = 502;
        body = JSON.stringify({ error: 'Track source body unreadable' });
      }
    } else {
      body = text;
    }
    // Cache the 502 like any upstream error: /tracks/all costs OpenSky
    // credits, so a retry inside the window must not re-download the body.
    cachePut(key, { at: Date.now(), status, body });
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  }

  function install(middlewares) {
    middlewares.use('/api/flights/track', async (req, res) => {
      try {
        const incoming = new URL(req.url || '', 'http://localhost');
        const icao24 = String(incoming.searchParams.get('icao24') || '')
          .trim()
          .toLowerCase();
        if (!/^[0-9a-f]{6}$/.test(icao24)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ error: 'icao24 must be a 6-char hex string' }),
          );
          return;
        }
        if (flightsProvider() === 'adsb-lol') {
          await proxyJson(
            res,
            `lol-path:${icao24}`,
            readsbTraceUrl(icao24),
            {},
            (text) =>
              JSON.stringify(
                openSkyTrackFromReadsbTrace(JSON.parse(text), icao24),
              ),
          );
          return;
        }
        const token = await getOpenSkyToken();
        await proxyJson(
          res,
          `osky:${icao24}`,
          `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`,
          token ? { Authorization: `Bearer ${token}` } : {},
        );
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Track fetch failed' }));
      }
    });

    middlewares.use('/api/military/track', async (req, res) => {
      try {
        const incoming = new URL(req.url || '', 'http://localhost');
        const hex = String(incoming.searchParams.get('hex') || '')
          .trim()
          .toLowerCase();
        if (!/^[0-9a-f~]{6,7}$/.test(hex)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ error: 'hex must be a 6-7 char hex string' }),
          );
          return;
        }
        await proxyJson(res, `lol:${hex}`, readsbTraceUrl(hex));
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'adsb.lol trace fetch failed' }));
      }
    });
  }

  return {
    name: 'track-backfill-proxies',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
