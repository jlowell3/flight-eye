import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeInput } from './realtimeInput.js';
import { PUSH_TO_TALK_HOLD_DELAY_MS } from './realtimeInputPolicy.js';

function fakeTarget() {
  const listeners = new Map();
  const captured = [];
  return {
    captured,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    listenerCount: () =>
      [...listeners.values()].reduce((sum, list) => sum + list.length, 0),
    setPointerCapture: (id) => captured.push(['capture', id]),
    releasePointerCapture: (id) => captured.push(['release', id]),
    dispatch(type, init = {}) {
      const event = {
        type,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        defaultPrevented: false,
        stopped: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopImmediatePropagation() {
          this.stopped = true;
        },
        ...init,
      };
      for (const handler of [...(listeners.get(type) || [])]) {
        handler(event);
        if (event.stopped) break;
      }
      return event;
    },
  };
}

function fakeInput({ active = false, pushToTalkMode = false } = {}) {
  const calls = [];
  const state = { active };
  const root = { dataset: {}, querySelectorAll: () => [] };
  let input;
  const operations = {
    isActive: () => state.active,
    setStatus: (...args) => calls.push(['setStatus', ...args]),
    start: (settings) => {
      calls.push(['start', settings]);
      state.active = true;
      // As realtimeConnection does when a push-to-talk session starts.
      input.pushToTalkMode = Boolean(settings?.pushToTalk);
    },
    pauseRadioForVoice: () => calls.push(['pauseRadio']),
    bargeIn: () => calls.push(['bargeIn']),
    holdPointer: () => calls.push(['holdPointer']),
    releasePointerHold: () => calls.push(['releasePointerHold']),
    beginPointerTurn: (origin) => calls.push(['beginPointerTurn', origin]),
    mayClaimSpeaker: () => true,
  };
  input = new RealtimeInput({
    readUi: () => ({
      root,
      buttonLabel: { textContent: '' },
      helpDetail: { textContent: '' },
    }),
    readStream: () => null,
    readStatus: () => 'listening',
    operations,
  });
  input.pushToTalkMode = pushToTalkMode;
  return { input, calls, root, state };
}

test('a held touch claims the microphone like a held Space and the release mutes it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { input, calls, root } = fakeInput();
  const target = fakeTarget();
  input.bindPushToTalkPointer(target);
  target.dispatch('pointerdown');
  assert.deepEqual(calls, [['holdPointer']]);
  assert.deepEqual(target.captured, [['capture', 1]]);
  t.mock.timers.tick(PUSH_TO_TALK_HOLD_DELAY_MS);
  assert.deepEqual(calls.slice(1), [
    ['pauseRadio'],
    ['start', { pushToTalk: true }],
  ]);
  assert.equal(input.pushToTalkKeyHeld, true);
  assert.equal(root.dataset.pushToTalk, 'held');
  target.dispatch('pointerup');
  assert.equal(input.pushToTalkKeyHeld, false);
  assert.equal(root.dataset.pushToTalk, undefined);
  assert.equal(root.dataset.microphone, 'muted');
  assert.deepEqual(target.captured.at(-1), ['release', 1]);
  assert.ok(
    calls.some(([name]) => name === 'releasePointerHold'),
    'the pointer snapshot ends with the gesture',
  );
  const swallowed = target.dispatch('click');
  assert.equal(swallowed.defaultPrevented, true, 'the hold is not a toggle');
  assert.equal(swallowed.stopped, true);
  const later = target.dispatch('click');
  assert.equal(
    later.defaultPrevented,
    false,
    'a later tap is an ordinary click',
  );
});

test('a short tap never claims and leaves the click to the button', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { input, calls } = fakeInput();
  const target = fakeTarget();
  input.bindPushToTalkPointer(target);
  target.dispatch('pointerdown');
  t.mock.timers.tick(PUSH_TO_TALK_HOLD_DELAY_MS - 50);
  target.dispatch('pointerup');
  t.mock.timers.tick(PUSH_TO_TALK_HOLD_DELAY_MS);
  assert.deepEqual(calls, [['holdPointer'], ['releasePointerHold']]);
  assert.equal(input.pushToTalkKeyHeld, false);
  assert.equal(target.dispatch('click').defaultPrevented, false);
});

test('an open-mic session, a cancelled press and a secondary button are left alone', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const openMic = fakeInput({ active: true, pushToTalkMode: false });
  const target = fakeTarget();
  openMic.input.bindPushToTalkPointer(target);
  target.dispatch('pointerdown');
  t.mock.timers.tick(PUSH_TO_TALK_HOLD_DELAY_MS * 2);
  assert.deepEqual(
    openMic.calls,
    [],
    'a click-started session keeps its open mic',
  );
  target.dispatch('pointerup');

  const { input, calls } = fakeInput();
  const other = fakeTarget();
  input.bindPushToTalkPointer(other);
  other.dispatch('pointerdown', { button: 2 });
  t.mock.timers.tick(PUSH_TO_TALK_HOLD_DELAY_MS * 2);
  assert.deepEqual(calls, [], 'only the primary button holds');
  other.dispatch('pointerdown');
  other.dispatch('pointercancel');
  t.mock.timers.tick(PUSH_TO_TALK_HOLD_DELAY_MS * 2);
  assert.deepEqual(calls, [['holdPointer'], ['releasePointerHold']]);
  assert.equal(input.pushToTalkKeyHeld, false);
});

test('binding is single and unbinding removes every listener', () => {
  const { input } = fakeInput();
  const target = fakeTarget();
  const unbind = input.bindPushToTalkPointer(target);
  assert.equal(target.listenerCount(), 5);
  const again = input.bindPushToTalkPointer(target);
  assert.equal(target.listenerCount(), 5, 'a second bind adds nothing');
  again();
  assert.equal(target.listenerCount(), 5, 'the no-op unbind removes nothing');
  unbind();
  assert.equal(target.listenerCount(), 0);
  assert.equal(input.bindPushToTalkPointer(null)(), undefined);
});
