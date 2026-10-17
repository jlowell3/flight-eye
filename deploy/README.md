# Hosting Flight Eye on one small VPS

> Shared hosting instead of a VPS (cPanel with "Setup Node.js App", as at
> o2switch)? See [CPANEL.md](CPANEL.md); the settings below still apply.

This folder is Phase 3 of `FLIGHT-EYE-PLAN.md`: the Flight Eye build served
from a VPS behind Caddy, with the server-side brakes a public OpenAI-billed
endpoint needs. One machine, no Docker:

```
phone ──HTTPS──▶ Caddy (TLS, :443) ──HTTP──▶ npm run serve:flight-eye (127.0.0.1:4173)
                 deploy/Caddyfile            deploy/flight-eye.service + /etc/flight-eye.env
```

| File                 | Installs as                              | Purpose                                                               |
| -------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| `Caddyfile`          | `/etc/caddy/Caddyfile`                   | Automatic TLS for the domain, reverse proxy to the Node server        |
| `flight-eye.service` | `/etc/systemd/system/flight-eye.service` | Runs `npm run serve:flight-eye` as the `flight-eye` user, boxed in    |
| `.env.vps.example`   | `/etc/flight-eye.env`                    | The settings below, read by the unit's `EnvironmentFile`              |
| `deploy.sh`          | run in place, as root                    | `git pull`, `npm ci`, `npm run build:flight-eye`, `systemctl restart` |

## Settings

Every setting is documented in `.env.example` at the repository root; these
are the ones a hosted Flight Eye needs. The first four are new in Phase 3
and are **off when unset**, so a local checkout behaves exactly as before.

| Setting                 | VPS value                        | What it does                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GEV_ALLOWED_HOSTS`     | `flight-eye.example.com`         | The public host, exactly as in the Caddyfile. Caddy passes the browser's `Host` through unchanged and the server (`build/allowedHosts.js`) answers only localhost, IP addresses and the names listed here; anything else is a 403 before any route runs.                                                                                                                    |
| `GEV_TRUSTED_PROXY`     | `127.0.0.1,::1,::ffff:127.0.0.1` | Exact socket addresses whose forwarding headers are believed (`server/providers/common/trusted-proxy.js`). From one of them, the same-site gate on the OpenAI routes takes the scheme from `X-Forwarded-Proto` and the host from `X-Forwarded-Host`, and the per-IP rate limits bucket on the first `X-Forwarded-For` address. Unset, forwarding headers are refused (403). |
| `GEV_APP_KEY`           | `openssl rand -hex 32`           | When set, `/api/realtime/token` and `/api/openai/hud-summary` require the same value in an `X-FlightEye-App-Key` header (constant-time compare, 401 JSON otherwise; `server/providers/common/app-key.js`). The page sends it from `window.FLIGHT_EYE_APP_KEY`, which the phone shell injects. An abuse brake, not authentication.                                           |
| `GEV_VOICE_DAILY_MINTS` | `40`                             | Successful voice token mints per UTC day, per app key (shared by every phone) or per client address when there is no app key (`server/providers/openai/mint-budget.js`). Past the cap the route answers 429 with `Retry-After` until midnight UTC. In memory: a restart forgets it.                                                                                         |
| `FLIGHTS_PROVIDER`      | `adsb-lol`                       | Aircraft data from adsb.lol only (ODbL, no key, 250 nm around the view). The default, `opensky`, is non-commercial.                                                                                                                                                                                                                                                         |
| `OPENAI_API_KEY`        | your key                         | Voice and HUD summaries. Set a usage limit on it in the OpenAI dashboard: the brakes above bound requests, not dollars.                                                                                                                                                                                                                                                     |
| `HOST`, `PORT`          | `127.0.0.1`, `4173`              | Set by the unit; Caddy is the only client. Change both places if you change them.                                                                                                                                                                                                                                                                                           |

Why the proxy setting exists: the server was written as a localhost dev
server. Its same-site gate (`src/localRequestGate.mjs`) refuses any request
carrying forwarding headers, and compares the browser's `Origin` against a
scheme computed from the socket, which behind TLS termination is always
`http`. Its rate limiters key on the socket address, which behind a proxy is
always the proxy. Trusting one loopback address fixes both without widening
anything else: a foreign `Origin`, an opaque origin or a cross-site fetch is
still refused, and a LAN peer that sends forwarding headers is still refused.

## Provisioning

Ubuntu 24.04 or Debian 12 is assumed; adjust package names elsewhere.

1. **DNS.** Point `flight-eye.example.com` (an A and, if you have one, an
   AAAA record) at the VPS. Open ports 22, 80 and 443 in its firewall; the
   Node server listens on loopback only.
2. **Node 24.** `package.json` requires 24.14 or newer. The NodeSource
   packages put `node` and `npm` in `/usr/bin`, which the unit expects:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs git
   ```

3. **Caddy.** Install from Caddy's apt repository (see caddyserver.com/docs/install), then:

   ```bash
   sudo install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
   ```

   Edit the domain in `/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`.

4. **User and checkout.**

   ```bash
   sudo useradd --system --home-dir /opt/flight-eye --shell /usr/sbin/nologin flight-eye
   sudo git clone --branch flight-eye <your fork> /opt/flight-eye
   sudo chown -R flight-eye:flight-eye /opt/flight-eye
   ```

5. **Settings.**

   ```bash
   sudo install -o root -g flight-eye -m 0640 /opt/flight-eye/deploy/.env.vps.example /etc/flight-eye.env
   ```

   Edit `/etc/flight-eye.env`: the domain, a fresh `GEV_APP_KEY`, the OpenAI
   key. Keep the app key out of the repository; the phone shell gets it at
   build time.

6. **Service.**

   ```bash
   sudo install -m 0644 /opt/flight-eye/deploy/flight-eye.service /etc/systemd/system/flight-eye.service
   sudo systemctl daemon-reload && sudo systemctl enable flight-eye
   ```

7. **First deploy.** `sudo /opt/flight-eye/deploy/deploy.sh` installs,
   builds, starts the service and checks it answers on loopback. Later
   updates are the same command.

## Smoke tests

From the VPS, against the Node server directly (loopback is always an
allowed host):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4173/
```

From anywhere, through Caddy:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://flight-eye.example.com/
curl -sS 'https://flight-eye.example.com/api/flights?lat=51.47&lon=-0.46' | head -c 300
```

The brakes, through Caddy. Without the app key the token route answers 401;
with it, 200 (a minted secret, which costs a session) or 503 when no OpenAI
key is configured:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' 'https://flight-eye.example.com/api/realtime/token?profile=flight-eye'
curl -sS -o /dev/null -w '%{http_code}\n' -H 'X-FlightEye-App-Key: <the key>' 'https://flight-eye.example.com/api/realtime/token?profile=flight-eye'
```

What a 403 on the token route means: a forwarding header was not believed
(`GEV_TRUSTED_PROXY` does not name the address Caddy connects from; check
`journalctl -u flight-eye` and the `Origin` the phone sends) or the `Host`
is not in `GEV_ALLOWED_HOSTS`.

## Not covered here

- The OpenAI usage limit: set it in the OpenAI dashboard. Nothing on the
  server counts dollars.
- Injecting `window.FLIGHT_EYE_APP_KEY` into the page: that is the phone
  shell's job (Phase 4).
- Backups and monitoring: the server keeps no state worth backing up
  (`.gev-cache` and `.gev-logs` are rebuilt), and `journalctl -u flight-eye`
  plus `journalctl -u caddy` are the logs.
