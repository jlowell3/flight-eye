import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VOICE_PROFILE,
  VOICE_PROFILES,
  isVoiceProfile,
  toolsForVoiceProfile,
} from './profiles.js';
import { standaloneVoiceTools } from '../../standalone/voiceTools.js';
import {
  FLIGHT_EYE_VOICE_PROFILE,
  FLIGHT_EYE_VOICE_TOOLS,
} from '../../../src/flightEye/voiceProfile.js';

test('the server knows the default and Flight Eye profiles', () => {
  assert.deepEqual(VOICE_PROFILES, [
    DEFAULT_VOICE_PROFILE,
    FLIGHT_EYE_VOICE_PROFILE,
  ]);
  for (const name of [null, undefined, '', 'standard', 'flight-eye'])
    assert.equal(isVoiceProfile(name), true, `${name} is a profile`);
  assert.equal(isVoiceProfile('cockpit'), false);
});

test('the default profile returns the session tools unchanged', () => {
  const tools = standaloneVoiceTools();
  for (const profile of [null, undefined, '', 'standard'])
    assert.equal(toolsForVoiceProfile(tools, profile), tools);
});

test('Flight Eye keeps exactly its allowlist, in the server order', () => {
  const tools = standaloneVoiceTools();
  const kept = toolsForVoiceProfile(tools, 'flight-eye');
  const allowed = new Set(FLIGHT_EYE_VOICE_TOOLS);
  assert.deepEqual(
    kept.map((tool) => tool.name),
    tools.map((tool) => tool.name).filter((name) => allowed.has(name)),
  );
  // Every allowlisted name is a real tool: a stale name fails here, not
  // on a phone.
  assert.equal(kept.length, FLIGHT_EYE_VOICE_TOOLS.length);
  for (const removed of [
    'control_cctv',
    'control_radio',
    'control_scene',
    'annotate_map',
    'fly_route',
    'next_iss_pass',
    'get_transit_vehicles',
    'find_radio_stations',
  ])
    assert.ok(
      !kept.some((tool) => tool.name === removed),
      `${removed} is not offered`,
    );
});

test('an unknown profile and an allowlist naming a missing tool are refused', () => {
  const tools = standaloneVoiceTools();
  assert.throws(() => toolsForVoiceProfile(tools, 'cockpit'), RangeError);
  assert.throws(() => toolsForVoiceProfile(null, 'flight-eye'), TypeError);
  assert.throws(
    () => toolsForVoiceProfile([{ name: 'fly_to_location' }], 'flight-eye'),
    /names a missing tool/,
  );
});
