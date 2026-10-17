/**
 * The readsb-style ADS-B upstreams behind /api/military and the regional
 * flight snapshot: adsb.lol first, then adsb.fi, which serves the same
 * `/v2/mil` and `/v2/lat/{lat}/lon/{lon}/dist/{nm}` routes in the same
 * format. One hobby feed being down (adsb.lol's API has had outages) must
 * not empty the aircraft layers.
 *
 * ADSB_API_BASES overrides the list (comma-separated base URLs, tried in
 * order). Only the two routes above move between bases; aircraft traces
 * stay on adsb.lol, which is the only one serving them.
 */

export const DEFAULT_ADSB_API_BASES = Object.freeze([
  'https://api.adsb.lol',
  'https://opendata.adsb.fi/api',
]);

/** The base URLs to try, in order, from ADSB_API_BASES or the defaults. */
export function adsbApiBases(env = process.env) {
  const raw = String(env?.ADSB_API_BASES ?? '').trim();
  if (!raw) return [...DEFAULT_ADSB_API_BASES];
  const bases = [];
  for (const entry of raw.split(',')) {
    const value = entry.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(value) || bases.includes(value)) continue;
    bases.push(value);
  }
  return bases.length ? bases : [...DEFAULT_ADSB_API_BASES];
}

/** The host a base URL names, for feed-source headers and logs. */
export function adsbBaseHost(base) {
  try {
    return new URL(base).hostname.replace(/^(api|opendata)\./, '');
  } catch {
    return String(base);
  }
}

/** Whether an upstream answer is worth relaying rather than trying the next base. */
function usable(response) {
  return response.ok || (response.status < 500 && response.status !== 429);
}

/**
 * Fetch `path` (such as `/v2/mil`) from the first base that answers with a
 * usable response: OK, or a client error other than 429, which the caller
 * relays as it would today. A thrown fetch, a timeout, a 429 or a 5xx moves
 * on to the next base. Resolves `{ response, base }`; when every base fails,
 * the last failure is rethrown, or the last failing response is returned so
 * existing cooldown handling still sees its status.
 */
export async function fetchAdsbUpstream(
  path,
  {
    fetchImpl = (...args) => fetch(...args),
    headers = {},
    timeoutMs = 10_000,
    env = process.env,
    bases = adsbApiBases(env),
  } = {},
) {
  let lastError = null;
  let lastFailure = null;
  for (const base of bases) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        headers: { Accept: 'application/json', ...headers },
        signal: controller.signal,
      });
      if (usable(response)) return { response, base };
      lastFailure = { response, base };
      response.body?.cancel?.().catch?.(() => {});
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (lastFailure) return lastFailure;
  throw lastError ?? new Error('No ADS-B upstream is configured');
}

/**
 * The aircraft rows of a readsb-style point or list response. adsb.lol
 * answers with `ac`; adsb.fi's point route answers with `aircraft`.
 */
export function readsbAircraftList(payload) {
  if (Array.isArray(payload?.ac)) return payload.ac;
  if (Array.isArray(payload?.aircraft)) return payload.aircraft;
  return [];
}
