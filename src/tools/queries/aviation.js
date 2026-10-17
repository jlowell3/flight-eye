/** Aviation queries over the live aircraft sources (src/sources/live). */

import { suggestView } from '../views.js';
import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  POINT_SCHEMA,
  areaCenter,
  areaContains,
  distanceKm,
  resolveArea,
  resolvePoint,
} from '../area.js';
import {
  LIMIT_SCHEMA,
  capRows,
  countNoun,
  isoTime,
  thinEvenly,
} from '../results.js';

const ICAO24_SCHEMA = Object.freeze({
  type: 'string',
  pattern: '^[0-9a-fA-F]{6}$',
  description: 'ICAO 24-bit address as six hex characters, such as "a1b2c3".',
});
const CALLSIGN_SCHEMA = Object.freeze({
  type: 'string',
  pattern: '^[A-Za-z0-9]{2,8}$',
  description: 'Flight callsign, such as "UAL123".',
});
const MILITARY_SCHEMA = Object.freeze({
  type: 'boolean',
  description: 'Use the military aircraft feed instead of the general feed.',
});
const MAX_TRACK_POINTS = 200;

const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

/** The common row for an aircraft record from any live aircraft source. */
function aircraftRow(record, from) {
  const point = { lat: record.latitude, lon: record.longitude };
  return {
    id: record.id,
    callsign: record.callsign || null,
    lat: round(record.latitude, 5),
    lon: round(record.longitude, 5),
    altitude_m: round(record.baroAltitudeM ?? record.ellipsoidAltitudeM, 0),
    on_ground: record.onGround === true,
    speed_mps: round(record.speedMps, 1),
    course_deg: round(record.courseDeg, 0),
    vertical_rate_mps: round(record.verticalRateMps, 1),
    type_code: record.typeCode || null,
    registration: record.registration || null,
    operator: record.operator || null,
    origin_country: record.originCountry || null,
    last_contact: isoTime(record.contactTimeMs ?? record.positionTimeMs),
    ...(from ? { distance_km: round(distanceKm(from, point), 1) } : {}),
  };
}

function snapshotInfo(snapshot) {
  return {
    source: snapshot.source ?? null,
    coverage: snapshot.coverage ?? null,
    observed_at: isoTime(snapshot.observedAtMs),
    freshness: snapshot.freshness ?? 'unknown',
  };
}

function feedFor(services, military) {
  if (!military) return services.aircraft;
  if (!services.military)
    throw new ToolError(
      'unsupported',
      'The military aircraft feed is not available here',
    );
  return services.military;
}

export const aircraftInArea = defineTool({
  name: 'aircraft_in_area',
  title: 'Aircraft in an area',
  description:
    'Aircraft currently reported inside an area, nearest the center first. ' +
    'Optionally military aircraft only, airborne only, or within an altitude band.',
  inputSchema: {
    type: 'object',
    properties: {
      area: AREA_SCHEMA,
      military: MILITARY_SCHEMA,
      airborne_only: { type: 'boolean' },
      min_altitude_m: { type: 'number', minimum: -500, maximum: 30000 },
      max_altitude_m: { type: 'number', minimum: -500, maximum: 30000 },
      limit: LIMIT_SCHEMA,
    },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['aircraft'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const center = areaCenter(area);
    const snapshot = await feedFor(services, args.military).getSnapshot(
      { latitude: center.lat, longitude: center.lon },
      { signal },
    );
    const altitude = (record) =>
      record.baroAltitudeM ?? record.ellipsoidAltitudeM;
    const rows = snapshot.records
      .filter(
        (record) =>
          areaContains(area, { lat: record.latitude, lon: record.longitude }) &&
          !(args.airborne_only && record.onGround) &&
          ((args.min_altitude_m == null && args.max_altitude_m == null) ||
            Number.isFinite(altitude(record))) &&
          (args.min_altitude_m == null ||
            altitude(record) >= args.min_altitude_m) &&
          (args.max_altitude_m == null ||
            altitude(record) <= args.max_altitude_m),
      )
      .map((record) => aircraftRow(record, center))
      .sort((a, b) => a.distance_km - b.distance_km);
    const kind = args.military ? 'military aircraft' : 'aircraft';
    // A regional fallback feed covers only part of the world around the
    // area's center; say so rather than imply a worldwide answer.
    const regional = /regional/i.test(snapshot.coverage || '');
    const notes = [
      ...(regional ? [`regional feed: ${snapshot.coverage}`] : []),
      ...(snapshot.freshness === 'stale' ? ['data may be stale'] : []),
    ];
    return {
      summary:
        `${rows.length} ${kind} in ${area.label}` +
        (notes.length ? ` (${notes.join('; ')}).` : '.'),
      data: {
        view: suggestView(services, {
          area,
          layers: [args.military ? 'military' : 'flights'],
        }),
        ...capRows(rows, args.limit),
        ...snapshotInfo(snapshot),
      },
    };
  },
});

export const findAircraft = defineTool({
  name: 'find_aircraft',
  title: 'Find an aircraft',
  description:
    'Find aircraft currently reported anywhere by callsign, ICAO 24-bit ' +
    'address or registration. Registrations are known only for aircraft in ' +
    'the military feed.',
  inputSchema: {
    type: 'object',
    properties: {
      callsign: CALLSIGN_SCHEMA,
      icao24: ICAO24_SCHEMA,
      registration: { type: 'string', minLength: 2, maxLength: 12 },
      limit: LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requires: ['aircraft'],
  async run(args, { services, signal }) {
    const given = ['callsign', 'icao24', 'registration'].filter(
      (key) => args[key] != null,
    );
    if (given.length !== 1)
      throw new ToolError(
        'invalid_arguments',
        'Give exactly one of callsign, icao24 or registration',
      );
    const [key] = given;
    const wanted = args[key].trim().toUpperCase();
    const field = {
      callsign: 'callsign',
      icao24: 'id',
      registration: 'registration',
    }[key];
    // Only the military feed reports registrations.
    const feeds = [
      ...(key === 'registration'
        ? []
        : [{ name: 'civil', feed: services.aircraft }]),
      { name: 'military', feed: services.military },
    ].filter(({ feed }) => feed);
    if (!feeds.length)
      throw new ToolError(
        'unavailable',
        'The military aircraft feed is not available here',
      );
    const settled = await Promise.allSettled(
      feeds.map(({ feed }) => feed.getSnapshot({}, { signal })),
    );
    signal?.throwIfAborted();
    // A search succeeds when any feed answers; missing feeds are named.
    const unavailable = feeds
      .filter((_, index) => settled[index].status === 'rejected')
      .map(({ name }) => name);
    if (unavailable.length === feeds.length) throw settled[0].reason;
    const seen = new Set();
    const matches = settled
      .flatMap((result, index) =>
        result.status === 'fulfilled'
          ? result.value.records.map((record) => ({
              record,
              feed: feeds[index].name,
            }))
          : [],
      )
      .filter(
        ({ record }) =>
          String(record[field] || '')
            .trim()
            .toUpperCase() === wanted,
      )
      .filter(({ record }) => !seen.has(record.id) && seen.add(record.id));
    const rows = matches.map(({ record }) => aircraftRow(record));
    // One match is shown followed; several are not framed.
    const only = matches.length === 1 ? matches[0] : null;
    // Each feed that answered, with its own freshness and coverage.
    const answered = feeds.flatMap(({ name }, index) =>
      settled[index].status === 'fulfilled'
        ? [{ feed: name, ...snapshotInfo(settled[index].value) }]
        : [],
    );
    const stale = answered
      .filter((feed) => feed.freshness === 'stale')
      .map((feed) => feed.feed);
    return {
      summary:
        (rows.length
          ? `Found ${countNoun(rows.length, 'aircraft', 'aircraft')} with ${key} ${wanted}.`
          : `No aircraft with ${key} ${wanted} is currently reported.`) +
        (unavailable.length
          ? ` The ${unavailable.join(' and ')} feed did not answer.`
          : '') +
        (stale.length
          ? ` The ${stale.join(' and ')} feed data may be stale.`
          : ''),
      data: {
        view: only
          ? suggestView(services, {
              point: { lat: only.record.latitude, lon: only.record.longitude },
              follow: {
                kind:
                  only.feed === 'military' ? 'military_aircraft' : 'aircraft',
                id: only.record.id,
              },
            })
          : null,
        ...capRows(rows, args.limit),
        unavailable_feeds: unavailable,
        stale_feeds: stale,
        feeds: answered,
      },
    };
  },
});

export const getAircraftTrack = defineTool({
  name: 'get_aircraft_track',
  title: 'Aircraft track',
  description:
    'Recent positions of one aircraft by ICAO 24-bit address, oldest first. ' +
    `Long tracks are evenly thinned to at most ${MAX_TRACK_POINTS} points.`,
  inputSchema: {
    type: 'object',
    properties: { icao24: ICAO24_SCHEMA, military: MILITARY_SCHEMA },
    required: ['icao24'],
    additionalProperties: false,
  },
  requires: ['aircraft'],
  async run(args, { services, signal }) {
    const icao24 = args.icao24.toLowerCase();
    // A track server answers 404 for an aircraft it has no positions for.
    const track = await feedFor(services, args.military)
      .getTrack(icao24, { signal })
      .catch((error) => {
        if (error?.status === 404) return { records: [] };
        throw error;
      });
    const points = [...track.records].sort(
      (a, b) => a.observedAtMs - b.observedAtMs,
    );
    const kept = thinEvenly(points, MAX_TRACK_POINTS);
    const first = points[0];
    const last = points.at(-1);
    return {
      summary: points.length
        ? `${countNoun(points.length, 'position')} for ${icao24} from ${isoTime(first.observedAtMs)} to ${isoTime(last.observedAtMs)}.`
        : `No recent track is available for ${icao24}.`,
      data: {
        view: last
          ? suggestView(services, {
              point: { lat: last.latitude, lon: last.longitude },
              follow: {
                kind: args.military ? 'military_aircraft' : 'aircraft',
                id: icao24,
              },
            })
          : null,
        icao24,
        total: points.length,
        returned: kept.length,
        thinned: kept.length < points.length,
        points: kept.map((point) => ({
          time: isoTime(point.observedAtMs),
          lat: round(point.latitude, 5),
          lon: round(point.longitude, 5),
          altitude_m: round(point.baroAltitudeM, 0),
          on_ground: point.onGround === true,
        })),
      },
    };
  },
});

export const getAircraftInfo = defineTool({
  name: 'get_aircraft_info',
  title: 'Aircraft type and route',
  description:
    'Look up an aircraft type and registration by ICAO 24-bit address, and ' +
    'a flight route by callsign, from adsbdb. Give either or both.',
  inputSchema: {
    type: 'object',
    properties: { icao24: ICAO24_SCHEMA, callsign: CALLSIGN_SCHEMA },
    additionalProperties: false,
  },
  requires: ['aircraft'],
  async run(args, { services, signal }) {
    if (args.icao24 == null && args.callsign == null)
      throw new ToolError('invalid_arguments', 'Give icao24, callsign or both');
    const lookup = (kind, id) =>
      id == null
        ? null
        : services.aircraft.getEnrichment({ kind, id }, { signal });
    const icao24 = args.icao24?.toLowerCase();
    const callsign = args.callsign?.toUpperCase();
    const [type, route] = await Promise.all([
      lookup('type', icao24),
      lookup('route', callsign),
    ]);
    const aircraft = type?.found
      ? {
          icao24,
          type_code: type.typeCode ?? null,
          type_name: type.typeName ?? null,
          registration: type.registration ?? null,
        }
      : null;
    const airport = (value) =>
      value
        ? {
            code: value.code || null,
            name: value.name || null,
            lat: value.lat ?? null,
            lon: value.lon ?? null,
          }
        : null;
    const flight = route?.found
      ? {
          callsign,
          airline: route.airline ?? null,
          origin: airport(route.origin),
          destination: airport(route.destination),
        }
      : null;
    const parts = [];
    if (icao24)
      parts.push(
        aircraft
          ? `aircraft ${icao24} is ${aircraft.type_name || aircraft.type_code || 'an aircraft of unknown type'}${aircraft.registration ? ` (${aircraft.registration})` : ''}`
          : `no type is known for ${icao24}`,
      );
    if (callsign)
      parts.push(
        flight
          ? `flight ${callsign} flies ${flight.origin?.code || flight.origin?.name} to ${flight.destination?.code || flight.destination?.name}${flight.airline ? ` (${flight.airline})` : ''}`
          : `no route is known for ${callsign}`,
      );
    const summary = parts.join('; ');
    return {
      summary: `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.`,
      data: { aircraft, route: flight },
    };
  },
});

const STATION_SCHEMA = Object.freeze({
  type: 'string',
  pattern: '^[A-Za-z0-9]{4}$',
  description: 'ICAO station id, such as "KAUS".',
});

function describeMetar(metar) {
  const parts = [];
  if (metar.windDirectionDeg != null || metar.windKt != null) {
    const dir =
      metar.windDirectionDeg === 'VRB'
        ? 'variable'
        : metar.windDirectionDeg != null
          ? `${String(metar.windDirectionDeg).padStart(3, '0')}°`
          : 'unknown direction';
    parts.push(
      `wind ${dir} at ${metar.windKt ?? '?'} kt${metar.gustKt != null ? ` gusting ${metar.gustKt}` : ''}`,
    );
  }
  if (metar.visibilitySm != null)
    parts.push(`visibility ${metar.visibilitySm} sm`);
  if (metar.clouds?.length)
    parts.push(
      `clouds ${metar.clouds
        .map((layer) =>
          layer.baseFt != null
            ? `${layer.cover} ${layer.baseFt} ft`
            : layer.cover,
        )
        .join(', ')}`,
    );
  if (metar.temperatureC != null)
    parts.push(
      `temperature ${metar.temperatureC}°C${metar.dewpointC != null ? ` dewpoint ${metar.dewpointC}°C` : ''}`,
    );
  if (metar.altimeterInHg != null)
    parts.push(`altimeter ${metar.altimeterInHg.toFixed(2)} inHg`);
  if (metar.flightCategory) parts.push(metar.flightCategory);
  return parts.join(', ') || 'no decoded fields';
}

export const getMetar = defineTool({
  name: 'get_metar',
  title: 'METAR',
  description:
    'The latest METAR (aviation weather observation) for up to five ICAO ' +
    'stations, decoded: wind, visibility, clouds, temperature, altimeter ' +
    'and flight category, with the raw report. Use get_nearby_airports to ' +
    'find a station id near a point.',
  inputSchema: {
    type: 'object',
    properties: {
      stations: {
        type: 'array',
        items: STATION_SCHEMA,
        minItems: 1,
        maxItems: 5,
        description: 'ICAO station ids.',
      },
    },
    required: ['stations'],
    additionalProperties: false,
  },
  requires: ['aviation'],
  async run(args, { services, signal }) {
    const payload = await services.aviation.getMetar(args.stations, { signal });
    const metars = Array.isArray(payload?.metars) ? payload.metars : [];
    const stale = payload?.status === 'stale';
    const missing = args.stations
      .map((id) => id.toUpperCase())
      .filter((id) => !metars.some((metar) => metar.icao === id));
    const summary =
      [
        ...metars.map((metar) => `${metar.icao}: ${describeMetar(metar)}`),
        missing.length ? `no report for ${missing.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('. ') + (stale ? ' (data may be stale).' : '.');
    return {
      summary,
      data: {
        metars,
        missing,
        stale,
        retrieved_at: payload?.retrievedAt ?? null,
        source: payload?.source ?? null,
      },
    };
  },
});

export const getNearbyAirports = defineTool({
  name: 'get_nearby_airports',
  title: 'Nearby airports',
  description:
    'The nearest airports to a point from the bundled OurAirports index ' +
    '(large and medium airports, and small ones with scheduled service): ' +
    'ICAO and IATA codes, distance and bearing, elevation, runways and ' +
    'tower, ground, approach, ATIS and other frequencies.',
  inputSchema: {
    type: 'object',
    properties: {
      location: POINT_SCHEMA,
      radiusKm: {
        type: 'number',
        minimum: 1,
        maximum: 400,
        description: 'Search radius in kilometres (default 80).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'How many airports to return (default 5).',
      },
    },
    required: ['location'],
    additionalProperties: false,
  },
  requires: ['aviation'],
  async run(args, { services, signal }) {
    const point = await resolvePoint(args.location, { services, signal });
    const payload = await services.aviation.nearbyAirports(
      point.lat,
      point.lon,
      { radiusKm: args.radiusKm, limit: args.limit, signal },
    );
    const airports = Array.isArray(payload?.airports) ? payload.airports : [];
    const named = airports
      .slice(0, 3)
      .map(
        (airport) =>
          `${airport.icao || airport.ident} ${airport.name} ${airport.distanceNm} nm at ${String(airport.bearingDeg).padStart(3, '0')}°`,
      );
    return {
      summary: airports.length
        ? `${countNoun(airports.length, 'airport')} within ${args.radiusKm ?? 80} km of ${point.label}: ${named.join('; ')}.`
        : `No airports in the index within ${args.radiusKm ?? 80} km of ${point.label}.`,
      data: { location: point, airports, source: payload?.source ?? null },
    };
  },
});
