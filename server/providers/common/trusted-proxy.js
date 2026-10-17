/**
 * Reverse-proxy trust for the hosted Flight Eye build (FLIGHT-EYE-PLAN.md,
 * Phase 3). This server was written as a localhost dev server: every gate
 * treats forwarding headers as proof that a request did NOT originate on
 * this machine, and every rate limiter keys on the socket address. Behind a
 * TLS-terminating proxy such as Caddy both are wrong: the socket is always
 * the proxy on loopback, the scheme the browser used is only in
 * X-Forwarded-Proto, and the phone's address is only in X-Forwarded-For.
 *
 * GEV_TRUSTED_PROXY names the proxy's socket addresses (comma-separated,
 * exact, e.g. `127.0.0.1,::1,::ffff:127.0.0.1`). Only a connection FROM one
 * of them has its forwarding headers believed; a `::ffff:` IPv4-mapped form
 * matches its plain address, as in keySetupCore's trusted peers. The value
 * `any` trusts every connection: for shared hosting (cPanel's Passenger),
 * where the app is reachable only through the host's own proxy, over a
 * socket that reports no peer address at all. Unset, no address is trusted
 * and every caller behaves exactly as before. GEV_PROXY_SCHEME (`https` or
 * `http`) is the scheme the proxy terminates, used by the same-site gate
 * when a trusted proxy sends no X-Forwarded-Proto. This module imports
 * nothing so it can sit in any package boundary.
 */

/** The GEV_TRUSTED_PROXY value that trusts every connection. */
export const TRUST_ANY_PROXY = 'any';

/** Normalize a socket address for comparison; '' when there is none. */
function normalizeAddress(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, '');
}

/**
 * Parse GEV_TRUSTED_PROXY into the set of trusted (normalized) addresses.
 * Entries are exact addresses: blanks are dropped, and there are no
 * wildcards, prefixes or hostnames.
 * @param {string|undefined|null} value
 * @returns {Set<string>}
 */
export function parseTrustedProxies(value) {
  const trusted = new Set();
  for (const entry of String(value ?? '').split(',')) {
    const address = normalizeAddress(entry);
    if (address) trusted.add(address);
  }
  return trusted;
}

// The env is read per request (dotenv values land in process.env after this
// module is imported, see openai/rate-limit.js) and parsed once per value.
let cachedRaw;
let cachedSet = new Set();
function trustedProxies(env) {
  const raw = String(env?.GEV_TRUSTED_PROXY ?? '');
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSet = parseTrustedProxies(raw);
  }
  return cachedSet;
}

/**
 * Whether the request's own socket peer is a declared trusted proxy.
 * @param {{socket?: {remoteAddress?: string}}} req
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isTrustedProxy(req, env = process.env) {
  const trusted = trustedProxies(env);
  if (trusted.size === 0) return false;
  if (trusted.has(TRUST_ANY_PROXY)) return true;
  return trusted.has(normalizeAddress(req?.socket?.remoteAddress));
}

/**
 * The scheme a trusted proxy terminates (GEV_PROXY_SCHEME), as `https:` or
 * `http:`, or null when unset or unreadable. A fallback for proxies that send
 * no X-Forwarded-Proto; one that does is always believed first.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'https:'|'http:'|null}
 */
export function trustedProxyScheme(env = process.env) {
  const value = String(env?.GEV_PROXY_SCHEME ?? '')
    .trim()
    .toLowerCase()
    .replace(/:$/, '');
  return value === 'https' || value === 'http' ? `${value}:` : null;
}

/** First comma-separated value of a header, trimmed; '' when absent. */
export function firstForwarded(headers, name) {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value ?? '')
    .split(',')[0]
    .trim();
}

/**
 * The address to treat as the client's: the first X-Forwarded-For entry when
 * the socket peer is a trusted proxy and the header is present, otherwise
 * the socket address itself. Later entries in X-Forwarded-For are proxies the
 * trusted one received the request from, or whatever the client sent; only
 * the hop the trusted proxy appended is believed, which is the first entry
 * for a single proxy that overwrites nothing. Returns '' when neither exists.
 * @param {import('node:http').IncomingMessage} req
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function clientAddress(req, env = process.env) {
  const socketAddress = String(req?.socket?.remoteAddress || '');
  if (!isTrustedProxy(req, env)) return socketAddress;
  return firstForwarded(req?.headers, 'x-forwarded-for') || socketAddress;
}
