/**
 * Flight Eye: the aircraft-only build for phones. The same application,
 * layers and server as God's Eye View; only the aircraft feeds and the
 * cockpit are offered. src/flightEye/composition.js says what is kept and
 * removed; FLIGHT-EYE-PLAN.md beside the checkout holds the build plan.
 */
import './flight-eye.css';
import './phone.css';
import { createStandaloneApplication } from '../standalone/application.js';
import { describeError } from '../standalone/errors.js';
import { t } from '../i18n/index.js';
import { setMode as setDetectionMode } from '../data/detection.js';
import {
  FLIGHT_EYE_DETECTION_MODE,
  FLIGHT_EYE_HIDDEN_LAYERS,
  FLIGHT_EYE_SOURCES,
  FLIGHT_EYE_VOICE_PROFILE,
  applyFlightEyeBranding,
  flightEyeViewerOptions,
  loadFlightEyeToolCatalog,
} from './composition.js';
import { initPhoneShell } from './phoneShell.js';

// The voice backend reads the profile when it mints a session.
globalThis.GEV_VOICE_PROFILE = FLIGHT_EYE_VOICE_PROFILE;
applyFlightEyeBranding(document);

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
  sources: FLIGHT_EYE_SOURCES,
  streetLevelProviders: [],
  hiddenLayers: FLIGHT_EYE_HIDDEN_LAYERS,
  viewerOptions: flightEyeViewerOptions(),
  welcome: false,
  voice: { toolCatalog: loadFlightEyeToolCatalog },
});

/**
 * A launch without a share link starts in Contacts (live and military
 * flights on, cockpit entry allowed) with sparse detection: the phone's
 * default picture. On a phone the HUD takes its minimal layout, since the
 * tactical one is drawn for a wide screen. A share link restores exactly
 * what it names instead.
 */
async function startFlightEyeDefaults({ phone = false } = {}) {
  const styleManager = application.getComponents().controls?.styleManager;
  if (!styleManager) return;
  await Promise.resolve(styleManager.initialRestorePromise).catch(() => {});
  if (styleManager.hasShareState) return;
  setDetectionMode(FLIGHT_EYE_DETECTION_MODE);
  if (phone) styleManager.setHudLayout?.('minimal');
  const result = await styleManager.setContextMode('contacts');
  if (!result?.ok)
    console.warn('[Flight Eye] Contacts did not start:', result?.error);
}

application
  .start()
  .then(() => {
    // The phone layer mounts on touch devices (or ?ui=phone) once the
    // shell exists; the defaults below may still be restoring.
    const phone = initPhoneShell({ application });
    return startFlightEyeDefaults({ phone: Boolean(phone) });
  })
  .catch((error) => {
    console.error('Flight Eye initialization failed:', error);
    const loaderStatus = document.querySelector(
      '#loading-screen .loader-status',
    );
    loaderStatus.textContent = t('Error: {message}', {
      message: describeError(error),
    });
    loaderStatus.style.color = '#ff4444';
  });

export { application };
