/**
 * Voice profiles: which of the session's tools a build offers.
 *
 * The standard app offers every app action and every catalog tool on the
 * voice surface. A trimmed build such as Flight Eye asks for a profile on
 * the token request (`?profile=flight-eye`) so the session never learns
 * about tools whose layers that build removed; a tool the model cannot see
 * is a tool it cannot try. The allowlists are plain data the browser build
 * shares (src/flightEye/voiceProfile.js).
 */

import {
  FLIGHT_EYE_VOICE_PROFILE,
  FLIGHT_EYE_VOICE_TOOLS,
} from '../../../src/flightEye/voiceProfile.js';

/** The default profile: every tool the server was configured with. */
export const DEFAULT_VOICE_PROFILE = 'standard';

const PROFILES = Object.freeze({
  [DEFAULT_VOICE_PROFILE]: null,
  [FLIGHT_EYE_VOICE_PROFILE]: FLIGHT_EYE_VOICE_TOOLS,
});

/** The profile names a token request may ask for. */
export const VOICE_PROFILES = Object.freeze(Object.keys(PROFILES));

/** Whether `name` is a profile this server knows; null and '' mean default. */
export function isVoiceProfile(name) {
  return name == null || name === '' || Object.hasOwn(PROFILES, name);
}

/**
 * The tools a profile offers, in the server's order. The default profile
 * returns `tools` unchanged. A named profile keeps only its allowlist and
 * throws when the allowlist names a tool the server does not have, so a
 * renamed tool cannot silently vanish from a build.
 */
export function toolsForVoiceProfile(tools, profile) {
  if (!Array.isArray(tools)) throw new TypeError('Session tools are required');
  if (!isVoiceProfile(profile))
    throw new RangeError(`Unknown voice profile: ${profile}`);
  const allow = PROFILES[profile || DEFAULT_VOICE_PROFILE] ?? null;
  if (!allow) return tools;
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of allow) {
    if (!names.has(name))
      throw new Error(`Voice profile ${profile} names a missing tool: ${name}`);
  }
  const allowed = new Set(allow);
  return tools.filter((tool) => allowed.has(tool.name));
}
