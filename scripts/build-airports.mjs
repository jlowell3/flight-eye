#!/usr/bin/env node
/**
 * Build the bundled airport index for Flight Eye's ATC persona and the
 * get_nearby_airports tool from OurAirports (public domain):
 *
 *   node scripts/build-airports.mjs <airports.csv> <runways.csv> <airport-frequencies.csv>
 *
 * The three tables come from https://ourairports.com/data/ (the daily
 * export at https://davidmegginson.github.io/ourairports-data/). The index
 * keeps large and medium airports plus small airports with scheduled
 * service, their open runways and the frequencies a controller would read
 * (tower, ground, approach, departure, ATIS, AWOS/ASOS, CTAF, UNICOM,
 * clearance delivery), and writes src/data/local_data/ourairports/
 * airports.json. See the README beside it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const OUTPUT_PATH = new URL(
  '../src/data/local_data/ourairports/airports.json',
  import.meta.url,
);

const KEPT_TYPES = new Set(['large_airport', 'medium_airport']);
const FREQUENCY_TYPES = new Set([
  'TWR',
  'GND',
  'APP',
  'DEP',
  'ATIS',
  'AWOS',
  'ASOS',
  'CTAF',
  'UNICOM',
  'CLD',
  'DEL',
]);
const MAX_FREQUENCIES = 8;
const MAX_RUNWAYS = 12;

/** Parse RFC 4180 CSV text into rows of strings (quotes, commas, newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += char;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Rows as objects keyed by the header row. */
export function csvRecords(text) {
  const [header, ...rows] = parseCsv(text);
  return rows.map((row) =>
    Object.fromEntries(header.map((name, index) => [name, row[index] ?? ''])),
  );
}

const num = (value, digits) => {
  const parsed = Number(value);
  if (value === '' || value == null || !Number.isFinite(parsed)) return null;
  return digits == null
    ? parsed
    : Math.round(parsed * 10 ** digits) / 10 ** digits;
};

/** Whether an OurAirports row belongs in the index. */
export function keepsAirport(row) {
  if (KEPT_TYPES.has(row.type)) return true;
  return row.type === 'small_airport' && row.scheduled_service === 'yes';
}

/**
 * Build the compact index from the three tables' records. Airports are
 * sorted by ident; runways and frequencies are attached by airport ident.
 */
export function buildAirportIndex({ airports, runways, frequencies }) {
  const kept = new Map();
  for (const row of airports) {
    if (!keepsAirport(row)) continue;
    const lat = num(row.latitude_deg, 5);
    const lon = num(row.longitude_deg, 5);
    if (lat == null || lon == null) continue;
    kept.set(row.ident, {
      ident: row.ident,
      icao: row.icao_code || (/^[A-Z]{4}$/.test(row.ident) ? row.ident : null),
      iata: row.iata_code || null,
      name: row.name,
      lat,
      lon,
      elevFt: num(row.elevation_ft, 0),
      type: row.type,
      city: row.municipality || null,
      country: row.iso_country || null,
      runways: [],
      frequencies: [],
    });
  }
  for (const row of runways) {
    const airport = kept.get(row.airport_ident);
    if (!airport || row.closed === '1') continue;
    if (airport.runways.length >= MAX_RUNWAYS) continue;
    const le = row.le_ident || null;
    const he = row.he_ident || null;
    if (!le && !he) continue;
    airport.runways.push({
      id: [le, he].filter(Boolean).join('/'),
      lengthFt: num(row.length_ft, 0),
      widthFt: num(row.width_ft, 0),
      surface: row.surface || null,
      lighted: row.lighted === '1',
      headings: [num(row.le_heading_degT, 0), num(row.he_heading_degT, 0)],
    });
  }
  for (const row of frequencies) {
    const airport = kept.get(row.airport_ident);
    if (!airport) continue;
    const type = String(row.type || '').toUpperCase();
    if (!FREQUENCY_TYPES.has(type)) continue;
    if (airport.frequencies.length >= MAX_FREQUENCIES) continue;
    const mhz = num(row.frequency_mhz, 3);
    if (mhz == null) continue;
    airport.frequencies.push({
      type,
      mhz,
      description: row.description || null,
    });
  }
  for (const airport of kept.values()) {
    airport.runways.sort((a, b) => (b.lengthFt ?? 0) - (a.lengthFt ?? 0));
  }
  return [...kept.values()].sort((a, b) => a.ident.localeCompare(b.ident));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [airportsPath, runwaysPath, frequenciesPath] = process.argv.slice(2);
  if (!airportsPath || !runwaysPath || !frequenciesPath) {
    console.error(
      'Usage: node scripts/build-airports.mjs <airports.csv> <runways.csv> <airport-frequencies.csv>',
    );
    process.exit(1);
  }
  const index = buildAirportIndex({
    airports: csvRecords(readFileSync(airportsPath, 'utf8')),
    runways: csvRecords(readFileSync(runwaysPath, 'utf8')),
    frequencies: csvRecords(readFileSync(frequenciesPath, 'utf8')),
  });
  const payload = {
    source: 'OurAirports (public domain), https://ourairports.com/data/',
    built: new Date().toISOString().slice(0, 10),
    count: index.length,
    airports: index,
  };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload)}\n`);
  console.log(
    `Wrote ${index.length} airports to ${fileURLToPath(OUTPUT_PATH)}`,
  );
}
