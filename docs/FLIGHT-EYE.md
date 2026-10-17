# Flight Eye

Flight Eye is the aircraft-only build of this checkout for phones: Live
Flights, Military Flights, click-to-track, the Contacts roster and Cockpit
view, with the sensor styles, detection overlay and HUD that ride along, and
voice. Every other layer is removed. The build plan, with its phases and
decisions, is `FLIGHT-EYE-PLAN.md` at the repository root.

## Running it

| Task                     | Command                                                        |
| ------------------------ | -------------------------------------------------------------- |
| Develop                  | `npm run dev`, then open `/flight-eye.html`                    |
| Build                    | `npm run build:flight-eye` (writes `dist-flight-eye/`)         |
| Serve the build with API | `npm run serve:flight-eye` (HOST, PORT, GEV_ALLOWED_HOSTS)     |
| Tests                    | `npm test`, `npm run check:boundaries`, `npm run format:check` |

The served build is the page at `/` plus the same `/api` routes as the
standard app, through Vite's preview server. A reverse proxy in front of it
needs the trusted-proxy handling described in the plan's hosting phase.

## How the build is composed

- `flight-eye.html` is `index.html` with the Flight Eye title, manifest
  (`public/flight-eye.webmanifest`), a `ui-flight-eye` body class and the
  entry `src/flightEye/main.js`. It keeps every `gev:template` block, since
  the shell reads those elements unguarded.
- `src/flightEye/composition.js` lists what is kept and removed. Every
  catalog source but `flights` and `military` is null (the layers register,
  report unavailable and refuse to enable), and the same layers plus
  Local ADS-B, Street Level and the bundled infrastructure are named as
  hidden, which removes them from Data Layers and the voice layer list.
- `src/flightEye/flight-eye.css` hides the panels the shell builds
  unconditionally for removed layers (CCTV, radio, scenes, street level,
  weather, recent imagery, the Space Missions tab, draw and import tools).
- A launch without a share link starts in Contacts with sparse detection, so
  both aircraft feeds are on and cockpit entry is allowed at once. The
  first-run launcher is skipped (`welcome: false`).
- On a touch device the viewer runs without MSAA at 30 frames per second
  (`flightEyeViewerOptions`); a desktop keeps the standard settings.
- Voice sends `profile=flight-eye` on the token request. The server
  (`server/providers/openai/profiles.js`) mints the session with the tools
  in `src/flightEye/voiceProfile.js` only, and the browser filters its own
  catalog to the same list.

## Server settings for Flight Eye

- `FLIGHTS_PROVIDER=adsb-lol` serves `/api/flights` from the adsb.lol
  snapshot within 250 nm of the view and `/api/flights/track` from adsb.lol
  traces rewritten into OpenSky's shape, never contacting OpenSky (whose
  licence is non-commercial). The default, `opensky`, is unchanged.
- `GEV_ALLOWED_HOSTS` must name the public host the phone app loads.
- An OpenAI key enables voice; see `.env.example` for the rest.

## Upstream edits

The build adds new files and keeps its edits to upstream modules small so
merges from `upstream/main` stay cheap: option passthroughs for
`hiddenLayers`, `viewerOptions` and `welcome` in the standalone composition,
a `hiddenLayerIds` set on the layer lifecycle, render options on
`createApplicationViewer`, a `profile` on the voice token request and its
server-side filter, and the `FLIGHTS_PROVIDER` switch in the aircraft
proxies. `scripts/check-import-directions.mjs` and
`scripts/package-boundaries.json` know the new entry and shared modules.
