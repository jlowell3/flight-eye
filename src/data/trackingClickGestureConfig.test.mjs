import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TRACKING_CLICK_TRAVEL_PX,
  configureTrackingClickGesture,
  isTrackingClickGesture,
  isTrackingSelectionGesture,
} from './trackingClickGesture.js';

test('a touch build may widen the click travel limit and restore it', (t) => {
  t.after(() => configureTrackingClickGesture());
  assert.equal(MAX_TRACKING_CLICK_TRAVEL_PX, 6);
  assert.equal(isTrackingSelectionGesture({ travelPx: 10 }), false);
  assert.equal(configureTrackingClickGesture({ travelPx: 14 }), 14);
  assert.equal(isTrackingSelectionGesture({ travelPx: 10 }), true);
  assert.equal(isTrackingSelectionGesture({ travelPx: 15 }), false);
  assert.equal(
    isTrackingClickGesture({ travelPx: 10, durationMs: 100 }),
    true,
    'the click classifier follows the same travel limit',
  );
  assert.equal(configureTrackingClickGesture(), 6);
  assert.equal(isTrackingSelectionGesture({ travelPx: 10 }), false);
  for (const travelPx of [-1, NaN, 'wide'])
    assert.throws(() => configureTrackingClickGesture({ travelPx }), TypeError);
});
