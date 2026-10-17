import { isUnavailableCapability } from '../sources/capability.js';
import { createOverpassFeatureSource } from '../sources/overpassFeatures.js';
/** Parse bounded retry information from a service response. */
function retryAfterMs(value) {
  if (value == null || String(value).trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000);
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Construct independent request services for compatible application protocols. */
export function createApplicationRequestServices({
  fetchImpl = (...args) => fetch(...args),
  signal: lifetime,
  endpoints = {},
  features,
  boundaryProbe = { timeoutMs: 3000, retryMs: 30_000 },
} = {}) {
  const urls = {
    boundaries: '/api/overpass',
    terrain: '/api/terrain/heights',
    regional: '/api/regional-brief',
    weather: '/api/weather-effects',
    summary: '/api/openai/hud-summary',
    // Flight Eye: METARs and the bundled airport index (server/providers/
    // aviation.js), read by the ATC persona and the aviation tools.
    metar: '/api/metar',
    airports: '/api/airports/nearby',
    ...endpoints,
  };
  async function request(endpoint, { signal, ...init } = {}) {
    signal = AbortSignal.any([lifetime, signal].filter(Boolean));
    signal.throwIfAborted();
    const response = await fetchImpl(endpoint, {
      ...init,
      signal,
      redirect: 'error',
    });
    signal.throwIfAborted();
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* Status remains authoritative for non-JSON errors. */
    }
    signal.throwIfAborted();
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      data,
    };
  }
  function pointUrl(endpoint, latitude, longitude) {
    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    )
      throw new TypeError('Valid coordinates are required');
    return `${endpoint}?${new URLSearchParams({ latitude: latitude.toFixed(5), longitude: longitude.toFixed(5) })}`;
  }
  function requireOk(response, label) {
    if (!response.ok)
      throw new Error(`${label} unavailable (${response.status})`);
    return response.data;
  }
  // Remember valid capability decisions for the page, so an
  // unconfigured server is never asked (and never answers with an error).
  // Discovery is bounded; failed, malformed or timed-out probes are forgotten and not
  // retried for a short backoff, during which queries go to the server as
  // they would against an older server without the probe.
  let boundaryCapability = null;
  let boundaryProbeRetryAt = 0;
  function boundariesConfigured() {
    if (boundaryCapability) return boundaryCapability;
    if (Date.now() < boundaryProbeRetryAt) return Promise.resolve(null);
    boundaryCapability = request(`${urls.boundaries}/status`, {
      signal: AbortSignal.timeout(boundaryProbe.timeoutMs),
    }).then(
      (response) => {
        if (response.ok && typeof response.data?.configured === 'boolean')
          return response.data.configured;
        boundaryCapability = null;
        boundaryProbeRetryAt = Date.now() + boundaryProbe.retryMs;
        return null; // capability unknown: let this query ask the server
      },
      (error) => {
        boundaryCapability = null;
        if (lifetime?.aborted) throw error;
        boundaryProbeRetryAt = Date.now() + boundaryProbe.retryMs;
        return null;
      },
    );
    return boundaryCapability;
  }
  /** Wait for a shared promise, but give up when this caller's signal aborts. */
  function untilAborted(promise, signal) {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
  }
  const services = {
    boundaries: {
      async query(query, { signal } = {}) {
        if ((await untilAborted(boundariesConfigured(), signal)) === false) {
          signal?.throwIfAborted();
          return {
            unavailable: true,
            code: 'OVERPASS_NOT_CONFIGURED',
            retryable: false,
          };
        }
        const response = await request(urls.boundaries, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (isUnavailableCapability(response.data))
          return {
            unavailable: true,
            code: 'OVERPASS_NOT_CONFIGURED',
            retryable: false,
          };
        const retry = response.headers?.get?.('Retry-After');
        if (
          response.status === 406 ||
          response.status === 429 ||
          (response.status === 503 && retry != null)
        )
          return { rateLimited: true, retryAfterMs: retryAfterMs(retry) };
        if (!response.ok) return null;
        const remark = String(response.data?.remark || '').toLowerCase();
        if (/runtime error|timed out|out of memory/.test(remark)) return null;
        return Array.isArray(response.data?.elements)
          ? response.data.elements
          : null;
      },
    },
    terrain: {
      async getHeights(points, { signal } = {}) {
        const query = points
          .map(({ lat, lon }) => `${lon.toFixed(5)},${lat.toFixed(5)}`)
          .join(';');
        return requireOk(
          await request(`${urls.terrain}?points=${encodeURIComponent(query)}`, {
            signal,
          }),
          'Terrain heights',
        )?.results;
      },
    },
    regional: {
      async getBrief(latitude, longitude, options) {
        return requireOk(
          await request(pointUrl(urls.regional, latitude, longitude), options),
          'Regional brief',
        );
      },
    },
    weather: {
      async getConditions(latitude, longitude, options) {
        return requireOk(
          await request(pointUrl(urls.weather, latitude, longitude), options),
          'Weather',
        );
      },
    },
    aviation: {
      /** The latest METARs for up to five ICAO station ids. */
      async getMetar(ids, options) {
        const list = (Array.isArray(ids) ? ids : [ids])
          .map((id) =>
            String(id ?? '')
              .trim()
              .toUpperCase(),
          )
          .filter(Boolean);
        if (!list.length) throw new TypeError('A station id is required');
        return requireOk(
          await request(
            `${urls.metar}?${new URLSearchParams({ ids: list.join(',') })}`,
            options,
          ),
          'METAR',
        );
      },
      /** The nearest bundled airports to a point, with runways and frequencies. */
      async nearbyAirports(
        latitude,
        longitude,
        { radiusKm, limit, ...options } = {},
      ) {
        const url = new URL(
          pointUrl(urls.airports, latitude, longitude),
          'http://localhost',
        );
        if (Number.isFinite(radiusKm))
          url.searchParams.set('radiusKm', String(radiusKm));
        if (Number.isFinite(limit))
          url.searchParams.set('limit', String(limit));
        return requireOk(
          await request(`${url.pathname}${url.search}`, options),
          'Nearby airports',
        );
      },
    },
    summary: {
      async summarize(context, { signal } = {}) {
        // Flight Eye: the phone shell sets window.FLIGHT_EYE_APP_KEY, which
        // the hosted server requires as X-FlightEye-App-Key (GEV_APP_KEY).
        // Read per request; the standard app has no key and sends no header.
        const appKey = globalThis.FLIGHT_EYE_APP_KEY;
        return request(urls.summary, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            ...(typeof appKey === 'string' && appKey
              ? { 'X-FlightEye-App-Key': appKey }
              : {}),
          },
          body: JSON.stringify(context),
        });
      },
    },
  };
  services.features =
    features ??
    createOverpassFeatureSource({
      boundarySource: services.boundaries,
      signal: lifetime,
    });
  return services;
}
