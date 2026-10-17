import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLIGHT_EYE_DETECTION_MODE,
  FLIGHT_EYE_HIDDEN_LAYERS,
  FLIGHT_EYE_KEPT_SOURCES,
  FLIGHT_EYE_SOURCES,
  FLIGHT_EYE_VOICE_PROFILE,
  flightEyeViewerOptions,
} from './composition.js';
import { CATALOG_SOURCE_CONTRACTS } from '../app/sourceComposition.js';
import { APPLICATION_LAYER_METADATA } from '../app/constructCatalog.js';
import { createStandaloneLayerSources } from '../standalone/layerSources.js';

test('every catalog source but the aircraft feeds is removed', () => {
  assert.deepEqual(FLIGHT_EYE_KEPT_SOURCES, ['flights', 'military']);
  for (const name of Object.keys(CATALOG_SOURCE_CONTRACTS)) {
    if (FLIGHT_EYE_KEPT_SOURCES.includes(name))
      assert.ok(!(name in FLIGHT_EYE_SOURCES), `${name} is kept`);
    else assert.equal(FLIGHT_EYE_SOURCES[name], null, `${name} is removed`);
  }
  assert.equal(FLIGHT_EYE_SOURCES.mapillary, null);
  // The standalone source table accepts every override name.
  const sources = createStandaloneLayerSources(FLIGHT_EYE_SOURCES);
  assert.equal(sources.cctv, null);
  assert.equal(typeof sources.flights.getSnapshot, 'function');
  assert.equal(typeof sources.military.getSnapshot, 'function');
});

test('hidden layers are real catalog layers and never the aircraft ones', () => {
  const known = new Set(APPLICATION_LAYER_METADATA.map(({ id }) => id));
  for (const id of FLIGHT_EYE_HIDDEN_LAYERS)
    assert.ok(known.has(id), `${id} is a catalog layer`);
  assert.equal(
    new Set(FLIGHT_EYE_HIDDEN_LAYERS).size,
    FLIGHT_EYE_HIDDEN_LAYERS.length,
  );
  for (const id of ['flights', 'military', 'military-awareness'])
    assert.ok(!FLIGHT_EYE_HIDDEN_LAYERS.includes(id), `${id} stays`);
  for (const id of [
    'cctv',
    'ais-live-vessels',
    'radio',
    'satellites',
    'local-adsb',
    'street-level',
    'local-datacenters',
    'local-dams',
    'weather-radar',
    'gnss-integrity',
  ])
    assert.ok(FLIGHT_EYE_HIDDEN_LAYERS.includes(id), `${id} is hidden`);
});

test('a touch device gets the phone render profile; a desktop keeps the defaults', () => {
  const matchMedia = (matches) => (query) => {
    assert.equal(query, '(pointer: coarse)');
    return { matches };
  };
  assert.deepEqual(flightEyeViewerOptions({ matchMedia: matchMedia(true) }), {
    msaaSamples: 1,
    targetFrameRate: 30,
  });
  assert.deepEqual(
    flightEyeViewerOptions({ matchMedia: matchMedia(false) }),
    {},
  );
  assert.deepEqual(flightEyeViewerOptions({}), {});
});

test('the build names its voice profile and detection profile', () => {
  assert.equal(FLIGHT_EYE_VOICE_PROFILE, 'flight-eye');
  assert.equal(FLIGHT_EYE_DETECTION_MODE, 'SPARSE');
});
