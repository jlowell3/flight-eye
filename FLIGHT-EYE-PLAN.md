# Flight Eye — build plan (Route A)

Status: approved 2026-10-17. Phases 0 to 5 are complete on branch `flight-eye` (2026-10-18): the build, the phone layer, hosting, the Flutter shell and the ATC voice persona. Phase 6 (device QA, attribution screen, store packaging) remains. See docs/FLIGHT-EYE.md for how to run the build.
Source: `gods-eye-view-main/` (upstream God's Eye View 0.2.1, MIT, Bilawal Sidhu).

## 1. What we are building

Flight Eye is a phone app that keeps only the aircraft side of God's Eye View:

- Live Flights and Military Flights on the 3D globe, with trails, emergency squawks and 24 h track history.
- Click-to-track, the 250 km Contacts roster, and Cockpit view with the briefing strip and optional clouds.
- The sensor looks (CRT, NVG, FLIR, Noir, Snow), detection overlay and HUD, because they ride along with the cockpit.
- Voice, with a new AI ATC / co-pilot persona that talks about the tracked flight using live telemetry, nearby contacts, weather, METARs and nearby airports.

It is a trimmed web build of the same codebase, served from a small server we host, loaded by a thin Flutter shell on the phone. Nothing is rewritten natively.

Out of v1: every other layer (ships, cameras, weather radar, transit, radio, satellites, and so on), Google Photorealistic 3D, airband radio via RTL-SDR, real ATC audio streams, iOS, offline use.

## 2. Architecture

```
Phone (Flutter shell)
  WebView  ──HTTPS──▶  VPS: Caddy (TLS)  ──▶  Node: vite preview serving dist-flight-eye + /api
  mic/location bridge                             │
  app key injected into page                      ├─▶ adsb.lol (flights fallback, military, traces)   ODbL
                                                  ├─▶ OpenSky (optional, non-commercial)              env switch
                                                  ├─▶ adsbdb (type, route)                           keyless
                                                  ├─▶ Open-Meteo, Nominatim, Google News RSS, GDELT  keyless
                                                  ├─▶ NOAA AWC METAR (new)                           keyless
                                                  └─▶ OpenAI: mint short-lived Realtime token
  WebRTC audio ──────────────────────────────────────▶ api.openai.com directly (as today)
```

Why the page is served from the VPS and not bundled in the app: the server sends no CORS headers, hard-codes root-relative `/api/...` paths in five client modules, and its same-site gate on the voice token route refuses a `null` or foreign Origin. Same-origin avoids all of that, and lets us ship web fixes without a store release.

Repository layout (one git repo, a fork of upstream so we can keep merging):

```
flight-eye/                 ← fork of bilawalsidhu/gods-eye-view, branch flight-eye, remote upstream
  flight-eye.html           ← new entry page
  src/flightEye/            ← entry module, hide list, phone layout, ATC context
  scripts/build-flight-eye.mjs, scripts/serve-flight-eye.mjs
  mobile/                   ← Flutter shell (rebuilt; the earlier one was deleted)
  deploy/                   ← Caddyfile, systemd unit, deploy script, .env.example for the VPS
  FLIGHT-EYE.md             ← this plan, kept current
```

Upstream changes are kept to a few small, flagged edits so merges stay cheap. New behaviour goes in new files.

## 3. Findings that shaped the plan

Composition and UI (from `src/app`, `src/standalone`, `src/ui`):

- The layer list is hard-coded in `src/app/constructCatalog.js` and four guards require every layer to be present, so layers cannot be omitted. The supported path is `sources: { name: null }` (the layer registers but reports unavailable) plus the existing `showInTogglePanel: false` flag, which removes the row from Data Layers and from the voice layer list.
- Local ADS-B and Military Awareness have no source contract and cannot be nulled. Awareness stays (it powers Contacts); Local ADS-B is only hidden.
- There is no multi-entry Vite setup. `scripts/build-panel.mjs` is the precedent for a second build with its own base and outDir. Runtime modes use a body class plus a CSS hide list (`ui/styles/embed.css`, `body.ui-clean-view` in `controls.css`).
- The shell builds the radio, CCTV and global-context panels unconditionally, so Flight Eye needs an explicit hide list. The radio panel also holds the Local ADS-B SDR card.
- Cockpit entry requires Contacts mode on with flights and military enabled; vessels and installations are deferred dependencies, so nulling them is tolerated. Next/previous contact and the helicopter filter already exist on `cockpitView.navigateContext`.
- There is no touch handling anywhere (no `pointer: coarse`, hover disclosure and panel dragging ignore touch on purpose). Only the Cesium camera handles touch. Below 760 px the cockpit already hides the right rail.
- Runtime performance knobs exist for detection density, 3D models and cockpit clouds. MSAA 4, frame rate 60 and the model caps are build constants, and there is no resolution-scale knob.

Server (from `server/`, `build/`):

- The API exists only as Vite dev and preview middleware. There is no production server and no TLS. `vite preview` serves `dist/` plus every aircraft route, so a reverse proxy in front of preview is the pragmatic v1.
- The host allowlist in `build/allowedHosts.js` needs `GEV_ALLOWED_HOSTS=<our domain>`.
- The same-site gate (`src/localRequestGate.mjs`) returns 403 when any proxy header is present or when the scheme computed from the socket does not match the Origin, which is exactly what a TLS-terminating proxy produces. Rate limits key on the socket address, so behind a proxy all phones share one bucket and the global caps (90 to 120 per minute) would throttle them.
- `/api/realtime/token?auth=api-key` has no loopback check. On a public server it is an OpenAI-billed endpoint open to anyone, limited only by a per-IP throttle. The $5 voice cap is enforced on the client only.
- Without OpenSky credentials the flights route still queries OpenSky anonymously and falls back to adsb.lol (250 nm around the camera point) on errors or stale data. There is no switch to disable OpenSky.

Voice (from `src/voice`, `server/providers/openai`):

- Session instructions are built on the server in `server/providers/openai/instructions.js`; the token request carries only `tier` and `auth`. After every tool call the client sends response-level instructions from `realtimeProtocol.js`, which replace the session instructions for that response. A persona must therefore be present in both places.
- The model gets no pushed situation data; it pulls view state, tracked entity and contact counts through tools. Per-contact bearing, distance and altitude delta are computed only for the HUD in `cockpitContext.js` and `cockpitMath.js`.
- No airports, runways, frequencies or METAR data exist in the repo. The adsbdb route lookup gives origin and destination codes with coordinates.
- Transport is WebRTC straight to OpenAI. It needs a secure context, `getUserMedia`, `RTCPeerConnection`, `AbortSignal.any` (Chromium 116+), and an autoplaying audio element. Push-to-talk is hold-Space only.

## 4. Phases

Estimates are for focused solo work and are rough. Phases 1, 3 and 4 are independent and can run in parallel once Phase 0 is done.

### Phase 0 — Repo and baseline (1 to 2 days)

1. Clone upstream with history into `flight-eye/`, add `upstream` remote, create branch `flight-eye`. (The zip extract has no git history, so we clone rather than reuse it.)
2. `npm install`, `npm run dev`, confirm the untouched app runs keyless on this PC (Esri imagery, anonymous OpenSky). Run `npm test` for a baseline.
3. Create the GitHub repository (private) and push.

Done when: the upstream app runs locally from our fork and CI-free tests pass.

### Phase 1 — Flight Eye web build (1.5 to 2.5 weeks)

1. Entry: `flight-eye.html` (keeps all nine `gev:template` blocks, since the shell reads them unguarded) and `src/flightEye/main.js`, which calls `createStandaloneApplication` with `sources` nulls for vessels, CCTV, traffic, transit, bikeshare, earthquakes, FIRMS, perimeters, cyclones, air quality, radio, satellites, launches, submarine cables, installations, ALPR, directions, recent imagery, weather and wind, and `streetLevelProviders: []`. Keep flights, military, awareness, local ADS-B (hidden).
2. Catalog: a small upstream edit so `constructCatalog` accepts a set of layer ids to mark `showInTogglePanel: false`, so nulled layers vanish from Data Layers and the voice layer list instead of showing UNAVAILABLE rows.
3. Tools phase: option flags in `src/app/tools.js` so the Flight Eye entry skips SceneDirector, annotations, the draw tool and geo-import.
4. Hide list: body class `ui-flight-eye` and `src/flightEye/flight-eye.css` modelled on the clean-view list, covering the CCTV panel and sync chips, street-level panel, scene panel, Space Missions tab, installations search, TR-3B toggle, cyber sonar, scope and celestial toggles, map-stack tray, world overlay actions, radio panel, and the first-run mission choices that reference removed layers.
5. Voice surface: filter the tool catalog through `catalogForSurface` to aircraft, cockpit, camera, style and HUD tools only.
6. Branding: title and manifest (`flight-eye.webmanifest`), logo and icons, loader and title bar strings, HUD summary prompt wording, console banner.
7. Data: a new `FLIGHTS_PROVIDER=adsb-lol|opensky` env switch in `server/providers/aircraft/opensky.js` so the server can skip OpenSky entirely (licence default) or use it (global coverage). The client already sends lat/lon anchors for the fallback.
8. Build and serve: `scripts/build-flight-eye.mjs` (modelled on `build-panel.mjs`, outDir `dist-flight-eye`) and `scripts/serve-flight-eye.mjs` that runs Vite preview programmatically on `0.0.0.0`.
9. Performance profile: make MSAA, target frame rate and a new `resolutionScale` configurable from the entry; Flight Eye defaults to MSAA off, 30 fps, scale 0.75 on high-DPI, detection density low, 3D models cockpit-only, clouds off by default.

Done when: `npm run build:flight-eye` produces a build that opens on the globe with only Flights, Military and the cockpit, tracks a plane, enters the cockpit, and nothing from the removed layers is reachable by click or voice.

### Phase 2 — Touch-first phone UI (1 to 2 weeks)

1. `@media (pointer: coarse)` layer: a bottom action bar (Track / Untrack, Cockpit, Previous and Next contact, Sensor cycle, Mic), a bottom-sheet telemetry card, a compact HUD, safe-area insets.
2. Replace keyboard-only paths: styles 1 to 7 become the sensor button cycle, H and D become a settings sheet, Esc becomes a visible Exit control (the shell's back button also triggers it).
3. Cockpit: large next and previous controls with class chips (All, Airliners, Helicopters, Military) wired to the existing `aircraftClass` filter.
4. Voice input: a hold-to-talk mic button routed through the same input policy as Space in `realtimeInput.js`, plus tap-to-toggle open mic. Replace hover pointer context with the tracked entity.
5. Tap-to-pick on the globe verified against the existing click gesture, with larger pick tolerance for fingers.

Done when: every v1 action is reachable with one thumb on a 6-inch phone, and the cockpit holds a usable frame rate on a mid-range Android device.

### Phase 3 — Backend hosting (3 to 5 days)

1. Server edits: a `GEV_TRUSTED_PROXY` setting so that, for connections from loopback, the same-site gate honours `X-Forwarded-Proto` instead of refusing, and the rate limiter buckets on `X-Forwarded-For`. Without this, Caddy's default headers break voice and all phones share one rate-limit bucket.
2. App key: the OpenAI routes (`/api/realtime/token`, `/api/openai/hud-summary`) require an `X-FlightEye-App-Key` header; the shell injects the key into the page at load. This is an abuse brake, not real auth; accounts come later if the app goes public.
3. Server-side spend brake: a daily mint cap per app key, and an OpenAI platform usage limit set in the OpenAI dashboard.
4. `deploy/`: Caddyfile (auto TLS), systemd unit for `serve-flight-eye.mjs`, a deploy script (git pull, `npm ci`, build, restart), VPS `.env.example` with `GEV_ALLOWED_HOSTS`, `FLIGHTS_PROVIDER`, `OPENAI_*`, optional `OPENSKY_*`.
5. Provision a small VPS (2 vCPU, 4 GB is plenty), point a subdomain at it, deploy, smoke-test every route from a phone browser.

Done when: `https://<domain>/` serves the Flight Eye build, flights load, voice connects from a phone's Chrome, and a request without the app key cannot mint a token.

### Phase 4 — Flutter shell (3 to 5 days)

Rebuild of the shell deleted earlier today, now pointed at the hosted origin, so the `HOST=127.0.0.1` and `adb reverse` steps go away.

1. Flutter 3.47 project `mobile/` with `webview_flutter`, `permission_handler`, `wakelock_plus`. Android first; the same shell builds for iOS later.
2. WebView setup: grant `onPermissionRequest` for the microphone, geolocation prompt bridging, `mediaPlaybackRequiresUserGesture = false` for the remote voice audio, immersive fullscreen, keep-awake while the page is visible.
3. App key injection via a JavaScript channel at page load, read by `src/flightEye/main.js`.
4. Back button: ask the page first (exit cockpit, close sheet), then leave the app. Native loading and offline/error screens.
5. Icon, splash, package id, signing config, minimum SDK with a note that the Android System WebView must be Chromium 116 or newer.
6. Test on a real Android phone over USB. The emulator on this PC cannot load HTTPS imagery because of Avast, so it is only useful for shell chrome.

Done when: the APK installs, loads the hosted app, voice works with the phone mic, and the back button behaves.

### Phase 5 — AI ATC / co-pilot persona (1.5 to 2.5 weeks)

1. Persona plumbing: `persona=atc|copilot|control` on the token request, read in `server/providers/openai/realtime.js`, and `instructions.js` gains persona blocks. The token response carries the persona preamble so `responseInstructionForToolResult` can prepend it on every tool-result response, which is where a session-only persona would otherwise be lost. Persona also selects the TTS voice.
2. Situation push: a client-side "cockpit situation" item sent as a system-role conversation event (the same mechanism as the existing map events) whenever it changes and at least every 15 s: tracked aircraft (callsign, type, altitude as flight level, heading, ground speed, vertical rate, squawk, route), phase of flight, the nearest contacts with relative bearing, distance and altitude delta reused from `cockpitContext.js`, and local weather. The HUD already computes most of this.
3. Airports: bundle OurAirports (public domain) airports, runways and frequencies filtered to medium and large airports, served by a new `/api/airports/nearby` route. Adds nearest airport, runway headings and lengths, tower and ATIS frequencies, field elevation.
4. METAR: a new `/api/metar` proxy to NOAA Aviation Weather Center (keyless) with caching, exposed as a `get_metar` voice tool. Gives wind, visibility, ceiling and altimeter, which Open-Meteo cannot.
5. Persona content: ICAO phraseology, phonetic alphabet, flight-level and altimeter formatting, readbacks, use of the real callsign; the co-pilot persona narrates in plain language. Both carry a fixed disclaimer that this is a simulation and not for navigation. Reduced tool set for the persona.
6. Cost: mini tier as the persona default, the server-side daily cap from Phase 3, and the existing client cost meter.

Done when: tracking a flight, entering the cockpit and asking "Flight Eye, say again our position" yields a controller-style answer that uses the live callsign, altitude, nearest airport and current METAR.

### Phase 6 — QA, attribution, store packaging (1 week)

1. Device matrix: one Pixel-class and one mid-range phone; battery and thermal over a 20-minute cockpit session; memory on a 4 GB device; network drop and recovery.
2. Attribution screen and the on-globe credit line kept visible: adsb.lol (ODbL), adsbdb, OpenSky if enabled, Esri World Imagery, OpenStreetMap, Open-Meteo, NOAA, OurAirports, upstream God's Eye View (MIT).
3. Privacy policy (microphone, location, voice audio to OpenAI), Play Store listing, simulated-ATC disclaimer in the listing and in-app.
4. Internal testing track on Google Play before any public release.

## 5. Decisions and defaults

| Decision           | Default in this plan                                               | Alternative                                                                                                                  |
| ------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Flight data source | adsb.lol only (ODbL, free, regional 250 nm around the view)        | OpenSky anonymous for the global "11,000 aircraft" view; non-commercial terms, needs a written agreement for a published app |
| Platform           | Android first                                                      | iOS from the same shell later (WKWebView supports WebRTC mic)                                                                |
| Basemap            | Esri World Imagery plus keyless terrain                            | Google 3D via Cesium ion (non-commercial) or a Google key (metered)                                                          |
| Shell              | Flutter WebView (your earlier choice; toolchain already installed) | Capacitor; same work, slightly less plumbing                                                                                 |
| Hosting            | One small VPS with Caddy and systemd                               | Docker on the VPS using the existing Dockerfile pattern                                                                      |
| Persona            | ATC by default, co-pilot selectable                                | Co-pilot only                                                                                                                |
| Abuse control      | App key plus rate limits plus spend caps                           | User accounts (needed before a public store release)                                                                         |

Needed from you before Phase 3: a domain or subdomain, a VPS (or permission to pick one), and an OpenAI API key with a usage limit set.

## 6. Risks

- **Phone performance.** Cesium with thousands of aircraft is heavy. Mitigation: the Phase 1 performance profile and regional adsb.lol data, verified on a real mid-range device early in Phase 2.
- **Vite preview as a server.** Upstream calls it "not a production server". Acceptable behind Caddy for a small app; if it becomes a problem, the providers are plain middleware functions and can be mounted on a bare Node HTTP server later.
- **Upstream drift.** Upstream moves fast. Keeping our edits small and flagged, with new code in new files, keeps merges cheap.
- **WebView variance.** Older Android System WebView builds lack `AbortSignal.any`. Mitigation: minimum WebView version check in the shell with an update prompt.
- **Billing exposure.** Voice minutes are metered per phone. Mitigation: app key, daily cap, OpenAI usage limit, mini tier default.
- **OpenSky terms.** Default to adsb.lol; only enable OpenSky for personal testing or after an agreement.

## 7. Licensing and attribution checklist

- Upstream code: MIT. Keep the LICENSE file and credit "based on God's Eye View by Bilawal Sidhu" in the app and listing.
- adsb.lol: ODbL 1.0, attribution required.
- OpenSky: non-commercial research and education licence; operational use may require written agreement.
- adsbdb: keyless, attribution.
- Esri World Imagery and OpenStreetMap: keep the Cesium credit line visible, including in clean and recording modes.
- Open-Meteo, NOAA (nowCOAST, Aviation Weather Center): attribution.
- OurAirports: public domain.
- OpenAI: voice audio leaves the device; disclose in the privacy policy.
