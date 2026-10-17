import { clientKey } from '../common/rate-limit.js';
import { configuredAppKey } from '../common/app-key.js';

/**
 * Daily spend brake for /api/realtime/token (FLIGHT-EYE-PLAN.md, Phase 3).
 *
 * Every successful mint starts a metered OpenAI voice session, and the
 * client's own $5 cap is only advisory. GEV_VOICE_DAILY_MINTS caps the
 * number of successful mints per UTC day: per app key when GEV_APP_KEY is
 * set (every phone with the key shares the cap, which is the point of a spend
 * brake), otherwise per client address. The count lives in memory, so a
 * restart forgets it; this is a brake, not accounting. The hard ceiling is
 * the usage limit set in the OpenAI dashboard. Off unless set.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the cap from its env value: a positive integer; unset, blank, zero,
 * negative or unreadable means off (0). A positive fraction counts as 1.
 * @param {string|number|undefined|null} envValue
 * @returns {number} Mints per UTC day; 0 means no cap.
 */
export function resolveDailyMintCap(envValue) {
  const raw = typeof envValue === 'string' ? envValue.trim() : envValue;
  if (raw === undefined || raw === null || raw === '') return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed < 1 ? 1 : Math.floor(parsed);
}

/**
 * An in-memory per-day, per-bucket counter.
 * @param {{cap: number, now?: () => number}} options
 */
export function createDailyMintBudget({ cap, now = () => Date.now() }) {
  let day = null;
  let counts = new Map();
  const today = () => {
    const current = Math.floor(now() / DAY_MS);
    if (current !== day) {
      // A new UTC day: yesterday's counts are irrelevant, drop them all.
      day = current;
      counts = new Map();
    }
    return counts;
  };
  return Object.freeze({
    cap,
    /** Whether `bucket` may mint again today. */
    allows(bucket) {
      return (today().get(bucket) || 0) < cap;
    },
    /** Count one successful mint for `bucket`. */
    record(bucket) {
      const current = today();
      current.set(bucket, (current.get(bucket) || 0) + 1);
    },
    /** Mints `bucket` has left today. */
    remaining(bucket) {
      return Math.max(0, cap - (today().get(bucket) || 0));
    },
    /** Whole seconds until the next UTC day, for Retry-After. */
    secondsUntilReset() {
      const at = now();
      return Math.max(
        1,
        Math.ceil(((Math.floor(at / DAY_MS) + 1) * DAY_MS - at) / 1000),
      );
    },
  });
}

// Built lazily on first request, like the OpenAI rate limiter: dotenv values
// reach process.env after this module is imported. `null` means off.
let _dailyMintBudget;

/** The process-wide budget from GEV_VOICE_DAILY_MINTS, or null when off. */
export function dailyMintBudget() {
  if (_dailyMintBudget === undefined) {
    const cap = resolveDailyMintCap(process.env.GEV_VOICE_DAILY_MINTS);
    _dailyMintBudget = cap > 0 ? createDailyMintBudget({ cap }) : null;
  }
  return _dailyMintBudget;
}

/**
 * The bucket a mint counts against: the configured app key (one shared cap
 * for the app) or, without one, the client address the rate limiter uses.
 * The key itself is never used as a map key; its presence is enough.
 */
export function mintBucket(req, env = process.env) {
  return configuredAppKey(env) ? 'app-key' : `address:${clientKey(req)}`;
}

/**
 * Apply the budget, writing a 429 when `bucket` has spent today's mints.
 * A null budget (the cap is off) is a no-op returning true.
 * @param {ReturnType<typeof createDailyMintBudget>|null} budget
 * @param {string} bucket
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} True if the request may proceed; false if a 429 was sent.
 */
export function enforceDailyMintCap(budget, bucket, res) {
  if (!budget || budget.allows(bucket)) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Retry-After', String(budget.secondsUntilReset()));
  res.end(
    JSON.stringify({
      error: 'Daily voice session limit reached',
      code: 'VOICE_DAILY_CAP_REACHED',
    }),
  );
  return false;
}
