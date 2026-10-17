/**
 * App key for the hosted Flight Eye build (FLIGHT-EYE-PLAN.md, Phase 3).
 *
 * On a public server the OpenAI routes are billed endpoints open to anyone
 * who finds them. GEV_APP_KEY is an abuse brake, not authentication: the
 * phone shell injects the key into the page, the page sends it as
 * `X-FlightEye-App-Key`, and a request without a matching header is refused
 * with 401 before any provider is contacted. Unset, nothing changes, so local
 * development and the standard app keep working without the header.
 *
 * Accounts replace this if the app goes public; until then, a leaked key is
 * rotated by changing the env value and shipping the shell again.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Request header the page sends; Node lower-cases incoming header names. */
export const APP_KEY_HEADER = 'x-flighteye-app-key';

/**
 * The configured key, or null when the check is off. Surrounding whitespace
 * is ignored so a trailing space in an env file does not lock every phone out.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function configuredAppKey(env = process.env) {
  const value = String(env?.GEV_APP_KEY ?? '').trim();
  return value || null;
}

/**
 * Constant-time comparison of a presented key with the expected one. Both
 * are hashed first so the comparison never depends on their lengths.
 * @param {unknown} presented
 * @param {string|null} expected
 */
export function appKeyMatches(presented, expected) {
  if (typeof presented !== 'string' || !presented || !expected) return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * Apply the app-key check to a request. Returns true when it has already
 * answered 401 (the caller returns); false when the handler should continue,
 * which is always the case while GEV_APP_KEY is unset.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} True when a 401 was sent.
 */
export function admitAppKey(req, res, env = process.env) {
  const expected = configuredAppKey(env);
  if (!expected) return false;
  const raw = req.headers?.[APP_KEY_HEADER];
  if (appKeyMatches(Array.isArray(raw) ? raw[0] : raw, expected)) return false;
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      error: 'A valid app key is required',
      code: 'APP_KEY_REQUIRED',
    }),
  );
  return true;
}

/**
 * Wrap a middleware handler so requests without the app key are refused
 * with 401 before the handler runs (a no-op while GEV_APP_KEY is unset).
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: Function) => unknown} handler
 */
export function appKeyGated(handler) {
  return (req, res, next) => {
    if (admitAppKey(req, res)) return undefined;
    return handler(req, res, next);
  };
}
