import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VOICE_PERSONA,
  VOICE_PERSONAS,
  isVoicePersona,
  personaResponsePreamble,
  personaSessionInstructions,
  personaVoice,
  resolveVoicePersona,
} from './personas.js';

test('personas are named, and unknown names fall back to the default', () => {
  assert.deepEqual(VOICE_PERSONAS, ['control', 'atc', 'copilot']);
  assert.equal(DEFAULT_VOICE_PERSONA, 'control');
  for (const name of [null, undefined, '', 'control', 'atc', 'copilot'])
    assert.equal(isVoicePersona(name), true, String(name));
  assert.equal(isVoicePersona('pilot'), false);
  assert.equal(resolveVoicePersona('atc'), 'atc');
  assert.equal(resolveVoicePersona('pilot'), 'control');
  assert.equal(resolveVoicePersona(null), 'control');
});

test('the controller and co-pilot personas state the simulation and read the situation', () => {
  assert.deepEqual(personaSessionInstructions('control'), []);
  for (const persona of ['atc', 'copilot']) {
    const lines = personaSessionInstructions(persona);
    assert.ok(lines.length >= 4, `${persona} has session lines`);
    assert.match(lines[0], /^PERSONA:/);
    assert.ok(
      lines.some((line) => /simulation/.test(line) && /never give/.test(line)),
      `${persona} refuses real instructions`,
    );
    assert.ok(
      lines.some((line) => /cockpit_situation/.test(line)),
      `${persona} reads the situation item`,
    );
    assert.ok(personaResponsePreamble(persona).length > 0);
  }
  assert.match(personaSessionInstructions('atc')[0], /air traffic controller/);
  assert.match(personaSessionInstructions('atc').join(' '), /niner/);
  assert.match(personaResponsePreamble('atc'), /callsign first/);
  assert.equal(personaResponsePreamble('control'), '');
  assert.equal(personaResponsePreamble(undefined), '');
});

test('each persona picks a voice that the environment can override', () => {
  assert.equal(personaVoice('control'), null);
  assert.equal(personaVoice('atc'), 'cedar');
  assert.equal(personaVoice('copilot'), 'marin');
  assert.equal(
    personaVoice('atc', { OPENAI_REALTIME_VOICE_ATC: ' ash ' }),
    'ash',
  );
  assert.equal(personaVoice('atc', { OPENAI_REALTIME_VOICE_ATC: '' }), 'cedar');
  assert.equal(
    personaVoice('copilot', { OPENAI_REALTIME_VOICE_COPILOT: 'sage' }),
    'sage',
  );
  assert.equal(
    personaVoice('nope', { OPENAI_REALTIME_VOICE_ATC: 'ash' }),
    null,
  );
});
