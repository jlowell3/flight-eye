/**
 * The cockpit situation feed (FLIGHT-EYE-PLAN.md, Phase 5): while a voice
 * session is live and an aircraft is tracked, the page pushes a
 * `cockpit_situation` system item into the conversation every few seconds
 * and whenever the session starts listening. The personas
 * (src/voice/personas.js) read it as the live picture: the tracked
 * aircraft, the nearest contacts with their bearing from the nose, the
 * nearest airports with runways and frequencies, and the latest METAR.
 *
 * `composeSituation` is pure and unit-tested; `createSituationFeed` wires it
 * to the running application. Nothing here speaks: the item carries data
 * only and never asks the model to respond.
 */

import * as Cesium from 'cesium';
import { bearingBetweenCoordinates, relativeBearing } from '../cockpitMath.js';

export const SITUATION_EVENT_TYPE = 'cockpit_situation';
export const SITUATION_INTERVAL_MS = 15_000;
const CONTACT_RADIUS_M = 150_000;
const CONTACT_LIMIT = 6;
const AIRPORT_RADIUS_KM = 120;
const AIRPORT_LIMIT = 3;
const AIRPORTS_REFRESH_MS = 5 * 60_000;
const METAR_REFRESH_MS = 10 * 60_000;
const TRACKED_LAYERS = ['flights', 'military'];

const M_TO_FT = 3.28084;
const MPS_TO_KT = 1.943844;
const MPS_TO_FPM = 196.8504;
const M_TO_NM = 1 / 1852;

const finite = (value) => (Number.isFinite(value) ? value : null);
const round = (value, digits = 0) =>
  value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits;
/** `value * factor`, rounded, or null when the value is not a number. */
const scaled = (value, factor, digits = 0) =>
  Number.isFinite(value) ? round(value * factor, digits) : null;
const clean = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

/** The phase of flight a controller would name from the readouts. */
export function phaseOfFlight({ onGround, altitudeFt, verticalRateFpm }) {
  if (onGround === true) return 'on the ground';
  if (verticalRateFpm != null && verticalRateFpm >= 300) return 'climbing';
  if (verticalRateFpm != null && verticalRateFpm <= -300) return 'descending';
  if (altitudeFt != null && altitudeFt >= 18_000) return 'cruising';
  return 'level';
}

/** FLxxx at and above 18,000 ft (the US transition altitude); else null. */
export function flightLevel(altitudeFt) {
  if (altitudeFt == null || altitudeFt < 18_000) return null;
  return `FL${String(Math.round(altitudeFt / 100)).padStart(3, '0')}`;
}

/** "twelve o'clock" … from a nose-relative bearing in -180..180. */
export function clockPosition(relativeBearingDeg) {
  if (relativeBearingDeg == null) return null;
  const hour = Math.round((((relativeBearingDeg % 360) + 360) % 360) / 30) % 12;
  const words = [
    'twelve',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
  ];
  return `${words[hour]} o'clock`;
}

function describeAircraft(info) {
  const altitudeFt =
    info.onGround === true ? 0 : scaled(info.altitudeM, M_TO_FT);
  const verticalRateFpm = scaled(info.verticalRateMps, MPS_TO_FPM);
  const heading = finite(info.track);
  return {
    callsign: clean(info.callsign),
    icao24: clean(info.icao24),
    registration: clean(info.registration),
    type: clean(info.typeName) || clean(info.typeCode),
    airline: clean(info.airline),
    altitude_ft: altitudeFt,
    flight_level: flightLevel(altitudeFt),
    heading_deg:
      heading == null ? null : Math.round(((heading % 360) + 360) % 360),
    ground_speed_kt: scaled(info.velocityMps, MPS_TO_KT),
    vertical_rate_fpm: verticalRateFpm,
    squawk: clean(info.squawk),
    emergency: clean(info.emergencyBroadcast),
    on_ground: info.onGround === true,
    phase: phaseOfFlight({
      onGround: info.onGround,
      altitudeFt,
      verticalRateFpm,
    }),
    route:
      info.origin || info.destination || info.route
        ? {
            origin: clean(info.origin || info.route?.origin?.code),
            destination: clean(
              info.destination || info.route?.destination?.code,
            ),
          }
        : null,
    position: {
      lat: round(finite(info.latitude), 4),
      lon: round(finite(info.longitude), 4),
    },
    stale: info.stale === true,
  };
}

/**
 * Compose the situation item. `tracked` is a layer's getTrackedInfo();
 * `contacts` are nearby aircraft with `lat`, `lon`, `distanceM` and the
 * fields of getNearby; `airports` come from /api/airports/nearby and
 * `metar` from /api/metar. Missing inputs leave their sections empty.
 */
export function composeSituation({
  tracked,
  contacts = [],
  airports = [],
  metar = null,
  now = Date.now(),
}) {
  if (!tracked) return null;
  const aircraft = describeAircraft(tracked);
  const own = aircraft.position;
  const heading = aircraft.heading_deg;
  const contactRows = [];
  for (const contact of contacts) {
    if (!contact || contact.icao24 === aircraft.icao24) continue;
    const bearing =
      own.lat != null &&
      own.lon != null &&
      Number.isFinite(contact.lat) &&
      Number.isFinite(contact.lon)
        ? bearingBetweenCoordinates(own.lat, own.lon, contact.lat, contact.lon)
        : null;
    const relative =
      bearing != null && heading != null
        ? relativeBearing(bearing, heading)
        : null;
    const altitudeFt = scaled(contact.altitudeM, M_TO_FT);
    contactRows.push({
      callsign: clean(contact.callsign) || clean(contact.icao24),
      aircraft_class: clean(contact.aircraftClass),
      bearing_deg: bearing == null ? null : Math.round(bearing),
      // `+ 0` turns a rounded -0 (dead ahead) into 0.
      relative_bearing_deg: relative == null ? null : Math.round(relative) + 0,
      clock_position: clockPosition(relative),
      distance_nm: scaled(contact.distanceM, M_TO_NM, 1),
      altitude_ft: altitudeFt,
      altitude_delta_ft:
        altitudeFt == null || aircraft.altitude_ft == null
          ? null
          : altitudeFt - aircraft.altitude_ft,
      heading_deg:
        contact.track == null
          ? null
          : Math.round(((contact.track % 360) + 360) % 360),
    });
    if (contactRows.length >= CONTACT_LIMIT) break;
  }
  const airportRows = airports.slice(0, AIRPORT_LIMIT).map((airport) => ({
    icao: airport.icao || airport.ident || null,
    iata: airport.iata || null,
    name: airport.name || null,
    distance_nm: airport.distanceNm ?? null,
    bearing_deg: airport.bearingDeg ?? null,
    elevation_ft: airport.elevFt ?? null,
    runways: (airport.runways || []).map((runway) =>
      runway.lengthFt != null
        ? `${runway.id} ${runway.lengthFt} ft`
        : runway.id,
    ),
    frequencies: Object.fromEntries(
      (airport.frequencies || []).map((frequency) => [
        frequency.type,
        frequency.mhz,
      ]),
    ),
  }));
  const metarRow = metar
    ? {
        icao: metar.icao,
        observed_at: metar.observedAt,
        raw: metar.raw,
        wind:
          metar.windDirectionDeg == null && metar.windKt == null
            ? null
            : `${metar.windDirectionDeg === 'VRB' ? 'variable' : metar.windDirectionDeg != null ? String(metar.windDirectionDeg).padStart(3, '0') : 'unknown'} at ${metar.windKt ?? '?'} kt${metar.gustKt != null ? ` gusting ${metar.gustKt}` : ''}`,
        visibility_sm: metar.visibilitySm,
        clouds: (metar.clouds || []).map((layer) =>
          layer.baseFt != null
            ? `${layer.cover} ${layer.baseFt} ft`
            : layer.cover,
        ),
        temperature_c: metar.temperatureC,
        dewpoint_c: metar.dewpointC,
        altimeter_inhg: metar.altimeterInHg,
        altimeter_hpa: metar.altimeterHpa,
        flight_category: metar.flightCategory,
      }
    : null;
  return {
    type: SITUATION_EVENT_TYPE,
    at: new Date(now).toISOString(),
    simulation: true,
    aircraft,
    contacts: contactRows,
    airports: airportRows,
    metar: metarRow,
  };
}

/**
 * Start the feed against a running application. Returns `{ tick, destroy }`.
 * The feed sends only while the voice session is active and an aircraft is
 * tracked; airports and METARs are refreshed on their own, slower clocks.
 */
export function createSituationFeed({
  application,
  intervalMs = SITUATION_INTERVAL_MS,
  now = () => Date.now(),
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
}) {
  const components = application.getComponents();
  const dataManager = components.data?.dataManager;
  const requests = components.scene?.operations?.requests;
  const session = components.tools?.voiceCommands?.session;
  if (!dataManager || !session) return null;

  const cache = { airports: null, airportsAt: 0, airportsKey: null };
  const metars = new Map();

  const trackedLayer = () => {
    for (const layerId of TRACKED_LAYERS) {
      const module = dataManager.layers.get(layerId)?.module;
      try {
        if (module?.getTrackedInfo?.()) return module;
      } catch {
        // not ready
      }
    }
    return null;
  };

  const nearbyContacts = (tracked) => {
    const center = Cesium.Cartesian3.fromDegrees(
      tracked.longitude,
      tracked.latitude,
      Number.isFinite(tracked.altitudeM) ? tracked.altitudeM : 0,
    );
    const rows = [];
    for (const layerId of TRACKED_LAYERS) {
      const module = dataManager.layers.get(layerId)?.module;
      let found = [];
      try {
        found =
          module?.getNearby?.(center, CONTACT_RADIUS_M, CONTACT_LIMIT + 1) ||
          [];
      } catch {
        found = [];
      }
      for (const item of found) {
        const carto = item?.position
          ? Cesium.Cartographic.fromCartesian(item.position)
          : null;
        rows.push({
          ...item,
          lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
          lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
          distanceM: item.distance,
        });
      }
    }
    rows.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
    return rows;
  };

  const airportsNear = async (tracked) => {
    const key = `${(Math.round(tracked.latitude * 5) / 5).toFixed(1)},${(Math.round(tracked.longitude * 5) / 5).toFixed(1)}`;
    const at = now();
    if (
      cache.airports &&
      cache.airportsKey === key &&
      at - cache.airportsAt < AIRPORTS_REFRESH_MS
    )
      return cache.airports;
    if (!requests?.aviation?.nearbyAirports) return cache.airports || [];
    try {
      const payload = await requests.aviation.nearbyAirports(
        tracked.latitude,
        tracked.longitude,
        { radiusKm: AIRPORT_RADIUS_KM, limit: AIRPORT_LIMIT },
      );
      cache.airports = Array.isArray(payload?.airports) ? payload.airports : [];
      cache.airportsAt = at;
      cache.airportsKey = key;
    } catch {
      // Keep whatever was known; the item says nothing about airports.
    }
    return cache.airports || [];
  };

  const metarFor = async (airports) => {
    const station = airports.find((airport) => airport.icao)?.icao;
    if (!station || !requests?.aviation?.getMetar) return null;
    const at = now();
    const cached = metars.get(station);
    if (cached && at - cached.at < METAR_REFRESH_MS) return cached.metar;
    try {
      const payload = await requests.aviation.getMetar([station]);
      const metar =
        (Array.isArray(payload?.metars) ? payload.metars : []).find(
          (row) => row.icao === station,
        ) || null;
      metars.set(station, { metar, at });
      return metar;
    } catch {
      return cached?.metar ?? null;
    }
  };

  let inFlight = false;
  const tick = async () => {
    if (inFlight || !session.isActive?.()) return false;
    const module = trackedLayer();
    const tracked = module?.getTrackedInfo?.();
    if (!tracked) return false;
    inFlight = true;
    try {
      const airports = await airportsNear(tracked);
      const metar = await metarFor(airports);
      if (!session.isActive?.()) return false;
      const latest = module.getTrackedInfo?.() || tracked;
      const payload = composeSituation({
        tracked: latest,
        contacts: nearbyContacts(latest),
        airports,
        metar,
        now: now(),
      });
      return Boolean(payload && session.sendMapEvent(payload));
    } catch {
      return false;
    } finally {
      inFlight = false;
    }
  };

  const timer = setIntervalImpl(() => void tick(), intervalMs);
  const unsubscribe = session.subscribe?.((event) => {
    if (event?.type === 'state' && event.state === 'listening') void tick();
  });
  return {
    tick,
    destroy() {
      clearIntervalImpl(timer);
      unsubscribe?.();
    },
  };
}
