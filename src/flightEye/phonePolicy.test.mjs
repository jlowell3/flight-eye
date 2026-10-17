import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_LABELS,
  CONTACT_FILTERS,
  PHONE_STYLE_CYCLE,
  actionBarState,
  backAction,
  cockpitHint,
  contactNavigationOptions,
  isPhoneUi,
  nextVisualStyle,
  telemetrySummary,
} from './phonePolicy.js';

test('the phone layer follows the ui query, then the pointer', () => {
  const coarse = (matches) => () => ({ matches });
  assert.equal(isPhoneUi({ matchMedia: coarse(true) }), true);
  assert.equal(isPhoneUi({ matchMedia: coarse(false) }), false);
  assert.equal(isPhoneUi({}), false);
  assert.equal(
    isPhoneUi({ matchMedia: coarse(false), search: '?ui=phone' }),
    true,
  );
  assert.equal(
    isPhoneUi({ matchMedia: coarse(true), search: '?x=1&ui=desktop' }),
    false,
  );
});

test('the sensor button cycles every visual style and wraps', () => {
  const seen = [];
  let style = 'normal';
  for (let step = 0; step < PHONE_STYLE_CYCLE.length; step++) {
    style = nextVisualStyle(style);
    seen.push(style);
  }
  assert.deepEqual(seen.slice(-1), ['normal']);
  assert.equal(new Set(seen).size, PHONE_STYLE_CYCLE.length);
  assert.equal(nextVisualStyle('unknown'), 'normal');
  assert.equal(nextVisualStyle(undefined), 'normal');
});

test('contact filters map to cockpit navigation options', () => {
  assert.deepEqual(
    CONTACT_FILTERS.map((filter) => filter.id),
    ['all', 'airliner', 'helicopter', 'military'],
  );
  assert.deepEqual(contactNavigationOptions('all'), {});
  assert.deepEqual(contactNavigationOptions('helicopter'), {
    aircraftClass: 'helicopter',
  });
  assert.deepEqual(contactNavigationOptions('military'), {
    targetLayer: 'military',
  });
  assert.deepEqual(contactNavigationOptions('nope'), {});
});

test('the action bar reads the shell state', () => {
  assert.deepEqual(actionBarState(), {
    trackLabel: ACTION_LABELS.focus,
    trackEnabled: false,
    cockpitLabel: ACTION_LABELS.cockpit,
    cockpitEnabled: false,
    navigationEnabled: false,
    chipsVisible: false,
  });
  assert.deepEqual(
    actionBarState({
      tracked: true,
      cockpitActive: true,
      cockpitEntryAllowed: false,
      contactsActive: true,
    }),
    {
      trackLabel: ACTION_LABELS.untrack,
      trackEnabled: true,
      cockpitLabel: ACTION_LABELS.exit,
      cockpitEnabled: true,
      navigationEnabled: true,
      chipsVisible: true,
    },
  );
  assert.equal(
    actionBarState({ contactsActive: true, cockpitEntryAllowed: true })
      .cockpitEnabled,
    true,
  );
});

test('a blocked cockpit tap gets a hint that names the missing step', () => {
  assert.match(cockpitHint('no-tracked-aircraft'), /Tap an aircraft/);
  assert.match(cockpitHint('contacts-starting'), /starting/);
  assert.match(cockpitHint('contacts-inactive'), /not running/);
  assert.equal(cockpitHint(undefined), cockpitHint('no-tracked-aircraft'));
  assert.equal(
    cockpitHint('something-else'),
    cockpitHint('no-tracked-aircraft'),
  );
});

test('the back gesture closes the most transient surface first', () => {
  assert.equal(
    backAction({ menuOpen: true, sheetExpanded: true, cockpitActive: true }),
    'close-menu',
  );
  assert.equal(
    backAction({ sheetExpanded: true, cockpitActive: true, panelOpen: true }),
    'collapse-sheet',
  );
  assert.equal(
    backAction({ cockpitActive: true, panelOpen: true }),
    'exit-cockpit',
  );
  assert.equal(backAction({ panelOpen: true }), 'close-panel');
  assert.equal(backAction(), null);
});

test('telemetry converts units and leaves unknown values out', () => {
  assert.equal(telemetrySummary(null), null);
  const summary = telemetrySummary({
    icao24: 'a46e35',
    callsign: 'DAL2534',
    typeName: 'Boeing 737-900',
    airline: 'Delta',
    altitudeM: 10187.94,
    velocityMps: 221.7,
    track: 283.55,
    verticalRateMps: -3.2,
    squawk: '2345',
    origin: 'ATL',
    destination: 'LAX',
    stale: false,
  });
  assert.equal(summary.title, 'DAL2534');
  assert.equal(summary.subtitle, 'Boeing 737-900 · Delta');
  assert.equal(summary.emergency, null);
  assert.deepEqual(
    summary.readouts.map(({ value }) => value),
    ['33,425 ft', '431 kt', '284°', '-630 fpm', '2345', 'ATL → LAX'],
  );
  const bare = telemetrySummary({ icao24: 'abc123', onGround: true });
  assert.equal(bare.title, 'ABC123');
  assert.equal(bare.subtitle, null);
  assert.deepEqual(
    bare.readouts.map(({ kind }) => kind),
    ['ground'],
  );
  const emergency = telemetrySummary({
    callsign: 'X',
    emergencyBroadcast: 'SQUAWK 7700',
    track: -10,
    verticalRateMps: 2,
  });
  assert.equal(emergency.emergency, 'SQUAWK 7700');
  assert.deepEqual(
    emergency.readouts.map(({ value }) => value),
    ['350°', '+394 fpm'],
  );
});
