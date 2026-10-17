#!/usr/bin/env bash
# Flight Eye: update the checkout on cPanel shared hosting and restart the
# Passenger app (deploy/CPANEL.md). Run from the cPanel Terminal as your
# account user, with the app's Node environment active:
#
#   source ~/nodevenv/flight-eye/24/bin/activate && ~/flight-eye/deploy/cpanel-update.sh
#
#   git pull                  fast-forward only
#   npm ci --include=dev      Vite serves the routes, so dev dependencies are
#                             needed even in production mode
#   npm run build:flight-eye  writes dist-flight-eye (or upload it, see the guide)
#   touch tmp/restart.txt     asks Passenger to restart the app
#
# Overrides: FLIGHT_EYE_DIR (~/flight-eye), FLIGHT_EYE_BRANCH (flight-eye),
# FLIGHT_EYE_SKIP_BUILD=1 to keep an uploaded dist-flight-eye.
set -euo pipefail

APP_DIR="${FLIGHT_EYE_DIR:-$HOME/flight-eye}"
BRANCH="${FLIGHT_EYE_BRANCH:-flight-eye}"

if ! command -v node >/dev/null 2>&1; then
  echo "cpanel-update.sh: node is not on PATH; activate the app's environment first:" >&2
  echo "  source ~/nodevenv/flight-eye/24/bin/activate" >&2
  exit 1
fi
if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "cpanel-update.sh: $APP_DIR is not a git checkout" >&2
  exit 1
fi

cd "$APP_DIR"
echo "==> Updating $APP_DIR ($BRANCH) with node $(node --version)"
git checkout --quiet "$BRANCH"
git pull --ff-only --quiet origin "$BRANCH"
echo "==> Installing dependencies"
PUPPETEER_SKIP_DOWNLOAD=1 npm ci --include=dev --no-audit --no-fund
if [[ "${FLIGHT_EYE_SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> Building Flight Eye"
  NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}" npm run build:flight-eye
fi
echo "==> Restarting the Passenger app"
mkdir -p tmp && touch tmp/restart.txt
echo "==> Done at $(git rev-parse --short HEAD); open https://$(grep -E '^GEV_ALLOWED_HOSTS=' .env 2>/dev/null | cut -d= -f2 | cut -d, -f1)/"
