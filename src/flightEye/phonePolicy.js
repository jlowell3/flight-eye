/**
 * Decisions for the Flight Eye phone layer, kept free of the DOM so they
 * run under node:test. src/flightEye/phoneShell.js applies them.
 */

import { msg } from '../i18n/marker.js';

/** Whether the phone layer is on: a `ui` query wins, else a coarse pointer. */
export function isPhoneUi({ matchMedia, search = '' } = {}) {
  const requested = new URLSearchParams(search || '').get('ui');
  if (requested === 'phone') return true;
  if (requested === 'desktop') return false;
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(pointer: coarse)')?.matches === true
  );
}

/** The sensor button steps through the visual styles in this order. */
export const PHONE_STYLE_CYCLE = Object.freeze([
  'normal',
  'retro',
  'surveillance',
  'thermal',
  'noir',
  'snow',
  'anime',
]);

/** The style after `current`; an unknown current style restarts the cycle. */
export function nextVisualStyle(current, cycle = PHONE_STYLE_CYCLE) {
  const index = cycle.indexOf(current);
  return cycle[(index + 1) % cycle.length];
}

/** Contact filters for Previous and Next, in chip order. */
export const CONTACT_FILTERS = Object.freeze([
  Object.freeze({ id: 'all', label: msg('ALL') }),
  Object.freeze({
    id: 'airliner',
    label: msg('AIRLINERS'),
    aircraftClass: 'airliner',
  }),
  Object.freeze({
    id: 'helicopter',
    label: msg('HELICOPTERS'),
    aircraftClass: 'helicopter',
  }),
  Object.freeze({
    id: 'military',
    label: msg('MILITARY'),
    targetLayer: 'military',
  }),
]);

/** The cockpit navigation options a filter chip selects. */
export function contactNavigationOptions(filterId) {
  const filter = CONTACT_FILTERS.find((entry) => entry.id === filterId);
  if (!filter) return {};
  const options = {};
  if (filter.targetLayer) options.targetLayer = filter.targetLayer;
  if (filter.aircraftClass) options.aircraftClass = filter.aircraftClass;
  return options;
}

/** Action bar labels and enablement from the shell's current state. */
export const ACTION_LABELS = Object.freeze({
  focus: msg('FOCUS'),
  untrack: msg('UNTRACK'),
  cockpit: msg('COCKPIT'),
  exit: msg('EXIT'),
  previous: msg('PREV'),
  next: msg('NEXT'),
  sensor: msg('SENSOR'),
  menu: msg('MENU'),
});

/**
 * What a tap on the greyed COCKPIT chip says, by the coordinator's
 * entryBlockedReason. A chip that only goes dim teaches nothing; the hint
 * names the one step that opens it.
 */
export const COCKPIT_HINTS = Object.freeze({
  'no-tracked-aircraft': msg('Tap an aircraft on the map first, then COCKPIT'),
  'contacts-starting': msg(
    'Contacts are still starting. Try again in a moment',
  ),
  'contacts-inactive': msg(
    'Aircraft contacts are not running yet. Try again in a moment',
  ),
});

export function cockpitHint(reason) {
  return COCKPIT_HINTS[reason] ?? COCKPIT_HINTS['no-tracked-aircraft'];
}

export function actionBarState({
  tracked = false,
  cockpitActive = false,
  cockpitEntryAllowed = false,
  contactsActive = false,
} = {}) {
  return {
    trackLabel: tracked ? ACTION_LABELS.untrack : ACTION_LABELS.focus,
    trackEnabled: tracked || contactsActive,
    cockpitLabel: cockpitActive ? ACTION_LABELS.exit : ACTION_LABELS.cockpit,
    cockpitEnabled: cockpitActive || cockpitEntryAllowed,
    navigationEnabled: contactsActive,
    chipsVisible: cockpitActive || contactsActive,
  };
}

/**
 * What the phone's back gesture does, most transient surface first. Null
 * means nothing is open and the shell may leave the app.
 */
export function backAction({
  menuOpen = false,
  sheetExpanded = false,
  cockpitActive = false,
  panelOpen = false,
} = {}) {
  if (menuOpen) return 'close-menu';
  if (sheetExpanded) return 'collapse-sheet';
  if (cockpitActive) return 'exit-cockpit';
  if (panelOpen) return 'close-panel';
  return null;
}

const METRES_TO_FEET = 3.28084;
const MPS_TO_KNOTS = 1.943844;
const MPS_TO_FPM = 196.8504;

export const TELEMETRY_LABELS = Object.freeze({
  altitude: msg('ALT'),
  groundSpeed: msg('GS'),
  heading: msg('HDG'),
  verticalRate: msg('V/S'),
  squawk: msg('SQK'),
  route: msg('ROUTE'),
  emergency: msg('EMERGENCY'),
  ground: msg('ON GROUND'),
});

const finite = (value) => (Number.isFinite(value) ? value : null);
const clean = (value) => String(value ?? '').trim();

/**
 * The telemetry sheet's title and readouts for a tracked aircraft, as the
 * layers describe it (getTrackedInfo): altitude in feet, ground speed in
 * knots, heading in degrees, vertical rate in feet per minute. Missing
 * values are left out rather than shown as zero.
 */
export function telemetrySummary(info) {
  if (!info) return null;
  const title =
    clean(info.callsign) ||
    clean(info.registration) ||
    clean(info.icao24).toUpperCase() ||
    null;
  const subtitle =
    [clean(info.typeName) || clean(info.typeCode), clean(info.airline)]
      .filter(Boolean)
      .join(' · ') || null;
  const readouts = [];
  const altitude = finite(info.altitudeM);
  if (info.onGround === true)
    readouts.push({
      label: TELEMETRY_LABELS.altitude,
      value: TELEMETRY_LABELS.ground,
      kind: 'ground',
    });
  else if (altitude != null)
    readouts.push({
      label: TELEMETRY_LABELS.altitude,
      value: `${Math.round(altitude * METRES_TO_FEET).toLocaleString('en-US')} ft`,
    });
  const speed = finite(info.velocityMps);
  if (speed != null)
    readouts.push({
      label: TELEMETRY_LABELS.groundSpeed,
      value: `${Math.round(speed * MPS_TO_KNOTS)} kt`,
    });
  const heading = finite(info.track);
  if (heading != null)
    readouts.push({
      label: TELEMETRY_LABELS.heading,
      value: `${String(Math.round(((heading % 360) + 360) % 360)).padStart(3, '0')}°`,
    });
  const verticalRate = finite(info.verticalRateMps);
  if (verticalRate != null) {
    const fpm = Math.round(verticalRate * MPS_TO_FPM);
    readouts.push({
      label: TELEMETRY_LABELS.verticalRate,
      value: `${fpm > 0 ? '+' : ''}${fpm} fpm`,
    });
  }
  const squawk = clean(info.squawk);
  if (squawk) readouts.push({ label: TELEMETRY_LABELS.squawk, value: squawk });
  const origin = clean(info.origin || info.route?.origin?.code);
  const destination = clean(info.destination || info.route?.destination?.code);
  if (origin || destination)
    readouts.push({
      label: TELEMETRY_LABELS.route,
      value: `${origin || '?'} → ${destination || '?'}`,
    });
  const emergency =
    clean(info.emergencyBroadcast) ||
    (info.emergency ? clean(info.emergency.kind || info.emergency.label) : '');
  return {
    title,
    subtitle,
    readouts,
    emergency: emergency || null,
    stale: info.stale === true,
  };
}
