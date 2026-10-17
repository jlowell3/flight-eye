# Flight Eye phone shell

A thin Flutter app that wraps the hosted Flight Eye web build in an Android
WebView. Everything the user sees is the web app; the shell adds what a
browser tab cannot: a home-screen icon and splash, fullscreen, keep-awake,
OS permission prompts for the microphone and location, the hardware back
button, native loading and offline screens, and a check that the phone's
WebView is new enough. Phase 4 of `FLIGHT-EYE-PLAN.md`.

Package id `com.globodyne.flight_eye`, app name "Flight Eye", Android 7.0
(API 24) and up. iOS builds from the same code later; nothing here is
Android-only except the small method channel in `MainActivity.kt`.

## Prerequisites

| Tool        | Where on this PC                                              |
| ----------- | ------------------------------------------------------------- |
| Flutter     | `C:\flutter` (3.47.2); `flutter` below means `C:\flutter\bin\flutter.bat` |
| Android SDK | `%LOCALAPPDATA%\Android\sdk`, platforms 33 to 37, platform-tools |
| JDK         | Android Studio's bundled JDK, found by Flutter automatically  |
| Node        | only to regenerate the icons (`tool/make-icons.mjs`)          |

Check with `flutter doctor`.

## Build and run

From this folder (`mobile/`):

```bash
flutter pub get
flutter analyze
flutter test
flutter build apk --debug
```

The APK lands in `build/app/outputs/flutter-apk/app-debug.apk`. Install it
on a connected phone or a running emulator with:

```bash
flutter install
```

or `adb install -r build/app/outputs/flutter-apk/app-debug.apk`. To run with
hot reload instead, `flutter run` with the same `--dart-define` flags as
below.

Release builds (`flutter build apk --release` or `appbundle`) currently sign
with the debug key; a real keystore and `key.properties` are part of the
store-packaging phase.

## Compile-time settings (`--dart-define`)

| Define               | Default                      | Meaning                                                            |
| -------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `FLIGHT_EYE_URL`     | `https://flighteye.example/` | The page the WebView loads. Placeholder until the hosted origin exists. |
| `FLIGHT_EYE_APP_KEY` | empty                        | Published to the page as `window.FLIGHT_EYE_APP_KEY` (see below).  |

The URL must be the **same origin that serves `/api`**: the server sends no
CORS headers and its same-site gate refuses requests from other origins, so
the page and the API have to share scheme, host and port. Navigations to any
other origin leave the WebView and open in the phone's browser.

### Pointing a build at the dev server

Build the web app and serve it with the API, bound to every interface
(`HOST=0.0.0.0` is the serve script's default; set it explicitly if your
`.env` overrides `HOST`):

```bash
npm run build:flight-eye
```

```bash
HOST=0.0.0.0 npm run serve:flight-eye
```

IP hosts always pass the server's Host-header check, so no
`GEV_ALLOWED_HOSTS` entry is needed for these. Then build the shell against
it:

- Emulator (`10.0.2.2` is the host PC from inside the emulator):

  ```bash
  flutter build apk --debug --dart-define=FLIGHT_EYE_URL=http://10.0.2.2:4173/flight-eye.html
  ```

- A phone on the same Wi-Fi, using the PC's LAN address (`ipconfig`):

  ```bash
  flutter build apk --debug --dart-define=FLIGHT_EYE_URL=http://192.168.1.20:4173/flight-eye.html
  ```

Plain `http://` works in **debug builds only**: `android/app/src/debug/AndroidManifest.xml`
sets `usesCleartextTraffic`, and the main manifest does not, so release
builds load HTTPS only.

A hosted build:

```bash
flutter build apk --release --dart-define=FLIGHT_EYE_URL=https://flighteye.example/ --dart-define=FLIGHT_EYE_APP_KEY=...
```

## What the shell does

- **WebView settings**: JavaScript and DOM storage on, zoom off,
  `mediaPlaybackRequiresUserGesture = false` so the voice session's
  autoplaying `<audio>` element can start without a tap, background colour
  `#0a0a0f` behind the page.
- **Permissions**: a `getUserMedia` microphone request from the page triggers
  the OS microphone prompt and is granted only if that says yes (anything
  else, such as the camera, is denied). `navigator.geolocation` triggers the
  OS location prompt the same way, and only for the app's own origin.
  Declared in the manifest: `INTERNET`, `RECORD_AUDIO`,
  `MODIFY_AUDIO_SETTINGS`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`.
- **Fullscreen**: immersive sticky mode; the system bars return on a swipe
  and hide again. Display cutouts are drawn into (`shortEdges`).
- **Keep-awake**: the screen stays on while the app is in the foreground and
  the page has loaded; it is released when the app goes to the background or
  the error screen is showing.
- **Loading screen**: native, shown from launch until the first page load
  finishes (the Android launch theme and splash use the same colour and logo,
  so there is no flash in between).
- **Offline / error screens**: a main-frame load failure (no network, DNS,
  timeout, TLS) or an HTTP error status for the page shows a native screen
  with a Retry button that reloads `FLIGHT_EYE_URL`. Failures of
  subresources (tiles, feeds) are left to the page.
- **WebView version**: at launch the shell reads the Chromium major from the
  WebView's user agent (falling back to the installed WebView package's
  version) and, below **116** (needed for `AbortSignal.any`), shows a dialog
  with an Update button that opens the Play Store page of Android System
  WebView. The app still runs after "Not now".
- **External links**: main-frame navigations to another origin, or to
  non-web schemes (`mailto:`, `tel:`), open outside the app.

## Page contract

The web side (`src/flightEye/main.js`) can rely on the following when it runs
inside the shell. None of it exists in a plain browser, so always feature-test.

### Globals set at page load

The shell runs a script at `onPageStarted` and again at `onPageFinished`:

```js
window.FLIGHT_EYE_APP_KEY = "<FLIGHT_EYE_APP_KEY define, '' when unset>";
window.FLIGHT_EYE_SHELL = { platform: "android", version: "1.0.0" };
window.dispatchEvent(new CustomEvent("flighteye:shell", { detail: window.FLIGHT_EYE_SHELL }));
```

Read `window.FLIGHT_EYE_APP_KEY` **when it is needed** (when minting a voice
token, as an `X-FlightEye-App-Key` header), not at module evaluation: the
first injection races the page's own scripts, the second one lands after
`load`. A page that wants it earlier can listen for `flighteye:shell`, or ask
for a fresh injection:

```js
window.FlightEyeShell?.postMessage("getAppKey");
```

`window.FlightEyeShell` is the JavaScript channel the shell registers.
Messages it understands: `getAppKey` (re-run the script above) and `ready`
(logged). Unknown messages are ignored.

### Back button

On a hardware or gesture back press the shell evaluates, in the page:

```js
typeof window.flightEyeBack === "function" && window.flightEyeBack() === true
```

If that is `true` the press is consumed and nothing else happens. Otherwise
the app exits (the shell never uses WebView history). So the page should
define `window.flightEyeBack` to close whatever is open (leave the cockpit,
close a sheet, clear a tracked flight) and return `true` when it did
something, `false` or `undefined` when there was nothing to close. The hook
must return synchronously; a Promise counts as "not handled".

Until the page implements the hook, back always exits.

## Verifying on the emulator

The AVD `Medium_Phone_API_35` exists on this PC, but **Avast breaks HTTPS
inside the emulator**: certificate checks fail, so imagery, flight feeds and
the voice token never load there. Use the emulator only for the shell's own
screens:

1. Start it (Android Studio's Device Manager, or
   `%LOCALAPPDATA%\Android\sdk\emulator\emulator.exe -avd Medium_Phone_API_35`).
2. `flutter install` (or `adb install -r ...`), then open Flight Eye.
3. With the placeholder URL you see the loading screen, then the offline
   screen ("Can't reach Flight Eye", DNS failure) with Retry. With the
   `10.0.2.2` override and the dev server running, the native loading
   screen gives way to the page's own "Initializing systems" splash, which
   stays there because the globe's imagery fails on TLS. The back button
   exits (the page has no `flightEyeBack` hook yet).

Everything that needs HTTPS (imagery, feeds, voice) has to be checked on a
real phone over USB (`adb devices`, then `flutter install`).

## Icons and splash

`android/app/src/main/res/mipmap-*/ic_launcher*.png`,
`drawable-*/splash_logo.png` and `assets/logo.png` are generated from the web
app's `public/icons/icon-512.png`, `icon-512-maskable.png` and
`public/logo.svg` by `tool/make-icons.mjs` (uses `sharp` from the
repository's `node_modules`). Regenerate from the repo root after changing
the source art:

```bash
node mobile/tool/make-icons.mjs
```

## Layout

| Path                              | What                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| `lib/main.dart`                   | App entry, theme, immersive mode                             |
| `lib/flight_eye_shell.dart`       | The WebView, its delegates, permissions, back, keep-awake    |
| `lib/screens.dart`                | Loading screen, error screen, WebView update dialog          |
| `lib/webview_support.dart`        | Pure helpers: version parsing, error classification, scripts |
| `lib/shell_channel.dart`          | Dart side of the method channel                              |
| `lib/config.dart`                 | The `--dart-define` values and colours                       |
| `android/app/src/main/kotlin/...` | `MainActivity.kt`: WebView version, open URL / Play Store    |
| `test/webview_support_test.dart`  | Unit tests for the helpers and the native screens            |
| `tool/make-icons.mjs`             | Icon and splash generator                                    |
