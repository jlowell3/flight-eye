#!/usr/bin/env bash
# Flight Eye: update the VPS checkout and restart the service
# (FLIGHT-EYE-PLAN.md, Phase 3). Run as root:
#   sudo /opt/flight-eye/deploy/deploy.sh
#
#   git pull                  as the service user, fast-forward only
#   npm ci                    exact lockfile install (Puppeteer's Chromium skipped)
#   npm run build:flight-eye  writes dist-flight-eye
#   systemctl restart         then a loopback health check
#
# Overrides: FLIGHT_EYE_DIR (/opt/flight-eye), FLIGHT_EYE_USER (flight-eye),
# FLIGHT_EYE_BRANCH (flight-eye), FLIGHT_EYE_SERVICE (flight-eye),
# FLIGHT_EYE_PORT (4173, the PORT in /etc/flight-eye.env).
set -euo pipefail

APP_DIR="${FLIGHT_EYE_DIR:-/opt/flight-eye}"
APP_USER="${FLIGHT_EYE_USER:-flight-eye}"
BRANCH="${FLIGHT_EYE_BRANCH:-flight-eye}"
SERVICE="${FLIGHT_EYE_SERVICE:-flight-eye}"
PORT="${FLIGHT_EYE_PORT:-4173}"
STATE_DIR="/var/lib/$SERVICE"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "deploy.sh: run as root (sudo); git and npm then run as $APP_USER" >&2
  exit 1
fi
if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "deploy.sh: $APP_DIR is not a git checkout" >&2
  exit 1
fi

# The unit's state directory holds npm's home and cache; systemd creates it on
# the first start, but a first deploy runs before that.
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$STATE_DIR"

# git and npm run as the service user so the checkout stays its own.
as_app() {
  runuser -u "$APP_USER" -- env \
    HOME="$STATE_DIR" \
    npm_config_cache="$STATE_DIR/npm-cache" \
    npm_config_update_notifier=false \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    "$@"
}

cd "$APP_DIR"
echo "==> Updating $APP_DIR ($BRANCH)"
as_app git checkout --quiet "$BRANCH"
as_app git pull --ff-only --quiet origin "$BRANCH"
echo "==> Installing dependencies"
as_app npm ci --no-audit --no-fund
echo "==> Building Flight Eye"
as_app npm run build:flight-eye
echo "==> Restarting $SERVICE"
systemctl restart "$SERVICE"

# Wait for the server to answer on loopback (an IP Host is always allowed).
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
    echo "==> $SERVICE is serving on 127.0.0.1:$PORT at $(as_app git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 1
done
echo "deploy.sh: $SERVICE did not answer on 127.0.0.1:$PORT; see: journalctl -u $SERVICE -n 50" >&2
exit 1
