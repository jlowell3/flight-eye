/**
 * Flight Eye composition: what the aircraft-only build keeps and removes.
 *
 * The application catalog registers every layer (its guards require that),
 * so the build removes layers by nulling their acquisition sources (they
 * report unavailable and refuse to enable) and names them as hidden (they
 * leave the Data Layers panel and the voice layer list). Everything else
 * here is the build's own defaults: a phone render profile, its voice tool
 * catalog and its branding of the shared templates.
 */

import { CATALOG_SOURCE_CONTRACTS } from '../app/sourceComposition.js';
import { msg } from '../i18n/marker.js';
import {
  FLIGHT_EYE_VOICE_PROFILE,
  FLIGHT_EYE_VOICE_TOOLS,
} from './voiceProfile.js';

export { FLIGHT_EYE_VOICE_PROFILE };

/** The acquisition sources the build keeps. */
export const FLIGHT_EYE_KEPT_SOURCES = Object.freeze(['flights', 'military']);

/**
 * Source overrides for createStandaloneApplication: every catalog contract
 * but the aircraft feeds is null, as is the Mapillary street-level source.
 */
export const FLIGHT_EYE_SOURCES = Object.freeze({
  ...Object.fromEntries(
    Object.keys(CATALOG_SOURCE_CONTRACTS)
      .filter((name) => !FLIGHT_EYE_KEPT_SOURCES.includes(name))
      .map((name) => [name, null]),
  ),
  mapillary: null,
});

/**
 * Layers without an acquisition contract that the build also leaves out:
 * the hardware receiver layer, street-level imagery (no providers) and the
 * bundled infrastructure datasets.
 */
const HIDDEN_WITHOUT_SOURCE = Object.freeze([
  'local-adsb',
  'street-level',
  'local-datacenters',
  'local-dams',
]);

/** Layer ids the build keeps registered but out of its panel and voice list. */
export const FLIGHT_EYE_HIDDEN_LAYERS = Object.freeze([
  ...new Set([
    ...Object.entries(CATALOG_SOURCE_CONTRACTS)
      .filter(([name]) => FLIGHT_EYE_SOURCES[name] === null)
      .flatMap(([, contract]) => contract.layers),
    ...HIDDEN_WITHOUT_SOURCE,
  ]),
]);

/**
 * Render settings for the viewer. A touch device (a phone or tablet) turns
 * MSAA off and halves the frame rate for battery and thermals; a desktop
 * keeps the standard app's settings.
 */
export function flightEyeViewerOptions({ matchMedia } = globalThis) {
  const coarse =
    typeof matchMedia === 'function' &&
    matchMedia('(pointer: coarse)')?.matches === true;
  return coarse ? { msaaSamples: 1, targetFrameRate: 30 } : {};
}

/** The detection density profile the build starts with. */
export const FLIGHT_EYE_DETECTION_MODE = 'SPARSE';

let pendingCatalog = null;

/**
 * The build's voice tool catalog: the standalone catalog on the voice
 * surface, with every tool outside the profile turned off. The server mints
 * the session with the same list, so this is the local half of one rule.
 */
export function loadFlightEyeToolCatalog() {
  pendingCatalog ??= Promise.all([
    import('../tools/index.js'),
    import('../tools/services.js'),
  ]).then(
    ([
      { composeCatalog, coreTools, catalogForSurface, toolsForSurface },
      { createToolServices },
    ]) => {
      const keep = new Set(FLIGHT_EYE_VOICE_TOOLS);
      const overrides = Object.fromEntries(
        toolsForSurface(coreTools, 'voice')
          .filter((tool) => !keep.has(tool.name))
          .map((tool) => [tool.name, { voice: false }]),
      );
      return catalogForSurface(
        composeCatalog({
          tools: coreTools,
          services: createToolServices({
            fetchImpl: (...args) => globalThis.fetch(...args),
            appUrl: new URL(globalThis.document.baseURI).origin,
          }),
        }),
        'voice',
        overrides,
      );
    },
  );
  pendingCatalog.catch(() => {
    pendingCatalog = null;
  });
  return pendingCatalog;
}

/** The tagline under the title; the markup's data-i18n translates it at boot. */
export const FLIGHT_EYE_TAGLINE = msg('LIVE AIRCRAFT · COCKPIT');

/**
 * Brand the shared templates: the title bar and loader read FLIGHT EYE and
 * the tagline becomes the build's own. Runs before the application
 * translates the document, so the tagline is still translated.
 */
export function applyFlightEyeBranding(doc = globalThis.document) {
  if (!doc) return;
  for (const brand of doc.querySelectorAll(
    '#title-bar h1 [translate="no"], #loading-screen h2[translate="no"]',
  )) {
    // i18n-ignore: product name
    brand.textContent = 'FLIGHT ';
    const accent = doc.createElement('span');
    accent.className = 'title-accent';
    // i18n-ignore: product name
    accent.textContent = 'EYE';
    brand.appendChild(accent);
  }
  const subtitle = doc.querySelector('#title-bar .subtitle');
  if (subtitle) subtitle.textContent = FLIGHT_EYE_TAGLINE;
}
