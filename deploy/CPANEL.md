# Hosting Flight Eye on cPanel shared hosting (o2switch)

The VPS guide (`README.md`) runs the server behind Caddy under systemd. On
shared hosting there is no root and no Caddy: cPanel's **Setup Node.js App**
runs the server under Phusion Passenger, and the host's own Apache or
LiteSpeed terminates HTTPS (AutoSSL) in front of it. Flight Eye supports that
through `passenger.cjs` at the repository root and two settings.

```
phone ──HTTPS──▶ host proxy (AutoSSL, gev.sg1.space) ──socket──▶ Passenger ──▶ passenger.cjs ──▶ npm run serve:flight-eye
```

This guide uses the subdomain `gev.sg1.space`, the account folder
`~/flight-eye` and Node 24.21.0, which o2switch offers. The Laravel and
WordPress sites on the same account are untouched: the Node app answers only
on its own subdomain, from its own folder. They share the account's CPU,
memory and disk limits, nothing else.

## 1. Subdomain

In cPanel, **Domains → Create a new domain**: `gev.sg1.space`, with its own
document root (the default, `public_html/gev.sg1.space`, is fine; Passenger
places a small `.htaccess` there). Wait for AutoSSL to issue the certificate
(**SSL/TLS Status**), which needs the name to resolve to the server.

## 2. Checkout

Open **Terminal** in cPanel (or SSH) and clone the branch:

```bash
git clone --branch flight-eye https://github.com/jlowell3/flight-eye.git ~/flight-eye
```

For a private repository use a GitHub personal access token with repository
read scope as the password, or add the account's SSH key to GitHub and clone
over SSH. **Git Version Control** in cPanel can also hold the clone; point
it at the same folder.

## 3. Settings

```bash
cp ~/flight-eye/deploy/.env.cpanel.example ~/flight-eye/.env
nano ~/flight-eye/.env
```

Fill in `GEV_APP_KEY` (a long random string; the phone shell is built with
the same value) and `OPENAI_API_KEY`. The template already sets:

| Setting                 | Value           | Why                                                                                                                                                                                   |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GEV_ALLOWED_HOSTS`     | `gev.sg1.space` | The server answers only this public host (plus localhost and IP addresses).                                                                                                           |
| `GEV_TRUSTED_PROXY`     | `any`           | Passenger hands requests over a socket with no peer address, so no address can be listed; every connection is the host's proxy. Never use `any` where the port is reachable directly. |
| `GEV_PROXY_SCHEME`      | `https`         | The gate on the voice routes compares the browser's `Origin` against the request scheme; when the proxy sends no `X-Forwarded-Proto`, this says what it terminates.                   |
| `GEV_VOICE_DAILY_MINTS` | `40`            | Spend brake; Passenger restarts reset it, so set an OpenAI usage limit too.                                                                                                           |
| `FLIGHTS_PROVIDER`      | `adsb-lol`      | No OpenSky (non-commercial licence).                                                                                                                                                  |

The file is read by the server at start (`.env` is ignored by git). The
cPanel form's **Environment variables** work too, but the file keeps the key
out of the UI and survives re-creating the app.

## 4. The Node app

**Setup Node.js App → Create Application**:

| Field                    | Value                                  |
| ------------------------ | -------------------------------------- |
| Node.js version          | `24.21.0` (24.14 or newer is required) |
| Application mode         | Production                             |
| Application root         | `flight-eye`                           |
| Application URL          | `gev.sg1.space` (the root, no path)    |
| Application startup file | `passenger.cjs`                        |

Create it, then **Stop App** for now; it has nothing to serve until the build
exists. The page shows the command that activates the app's Node environment
in the Terminal, of the form:

```bash
source ~/nodevenv/flight-eye/24/bin/activate && cd ~/flight-eye
```

## 5. Install and build

In the Terminal, with that environment active:

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm ci --include=dev --no-audit --no-fund
NODE_OPTIONS=--max-old-space-size=1536 npm run build:flight-eye
```

`--include=dev` matters: Vite's preview server is what serves the `/api`
routes, and Vite is a development dependency, which production mode would
otherwise skip. The build writes `dist-flight-eye/` and takes about a minute.

If the build is killed for memory (shared plans cap each process), build on
your PC instead, where it takes 15 seconds:

```bash
npm run build:flight-eye
```

then upload the `dist-flight-eye` folder into `~/flight-eye/` with **File
Manager** (zip it first) or SFTP, and run later updates with
`FLIGHT_EYE_SKIP_BUILD=1`.

## 6. Start and test

**Start App** in Setup Node.js App (or `touch ~/flight-eye/tmp/restart.txt`
after any change). Then, from anywhere:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://gev.sg1.space/
curl -sS 'https://gev.sg1.space/api/airports/nearby?latitude=48.86&longitude=2.35&limit=1' | head -c 200
curl -sS 'https://gev.sg1.space/api/flights?lat=48.86&lon=2.35' | head -c 200
curl -sS -o /dev/null -w '%{http_code}\n' 'https://gev.sg1.space/api/realtime/token?profile=flight-eye&persona=atc'
curl -sS -o /dev/null -w '%{http_code}\n' -H 'X-FlightEye-App-Key: <the key>' 'https://gev.sg1.space/api/realtime/token?profile=flight-eye&persona=atc'
```

Expected: 200, an airport, aircraft JSON, 401 (no app key) and 200 (a minted
voice secret, which costs one session) or 503 if no OpenAI key is set.

A 403 on the token route means the gate did not believe the forwarded
request: check that `GEV_TRUSTED_PROXY=any` and `GEV_PROXY_SCHEME=https` are
in `.env` and that the app was restarted after editing it. A 403 on every
route means `GEV_ALLOWED_HOSTS` does not match the host. Passenger's own log
is `~/flight-eye/stderr.log` (the path is shown in the app's page), and the
server's are under `~/flight-eye/.gev-logs/`.

## 7. The phone app

Build the shell against the hosted address (see `mobile/README.md`):

```bash
cd mobile
flutter build apk --dart-define=FLIGHT_EYE_URL=https://gev.sg1.space/ --dart-define=FLIGHT_EYE_APP_KEY=<the key>
```

## 8. Updating

```bash
source ~/nodevenv/flight-eye/24/bin/activate && ~/flight-eye/deploy/cpanel-update.sh
```

It pulls the branch, reinstalls, rebuilds and restarts the app
(`FLIGHT_EYE_SKIP_BUILD=1` keeps an uploaded build).

## What is different from the VPS

- Passenger starts the app on the first request and may stop it when idle;
  the first request after a pause is slower, and the in-memory caches, rate
  limits and the daily mint count start again. Nothing is lost that matters.
- Disk caches (`.gev-cache/`) and logs (`.gev-logs/`) live inside
  `~/flight-eye`, as on the VPS.
- There is no `systemctl`; the app page's **Restart** button or
  `tmp/restart.txt` restarts it.
