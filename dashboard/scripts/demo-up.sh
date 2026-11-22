#!/usr/bin/env bash
# Starts the Relay demo behind a temporary public HTTPS URL (Cloudflare quick tunnel).
# Run inside WSL (Ubuntu) with Docker Desktop running:
#
#   bash /mnt/c/Users/<you>/Projects/yc-hackathon/dashboard/scripts/demo-up.sh
#
# Keep the terminal open: Ctrl+C stops the app and the tunnel. Every start gets a NEW public URL, and this
# script points the ElevenLabs webhook tool at it. The database (and any rehearsal data) is reused.
set -euo pipefail

APP_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # dashboard/ in the repo
BUILD="${RELAY_BUILD_DIR:-$HOME/relay-build/dashboard}"      # Linux-side copy: Wasp is slow on /mnt/c
TUNNEL="relay-tunnel"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # nvm is not written for "set -eu": load and use it with those checks off.
  set +eu
  . "$NVM_DIR/nvm.sh"
  nvm use 24 >/dev/null
  set -eu
fi
command -v wasp >/dev/null || { echo "Wasp CLI not found. Run: npm i -g @wasp.sh/wasp-cli@0.22.0"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop, then run this again."; exit 1; }
[ -f "$APP_SRC/.env.server" ] || { echo "Missing $APP_SRC/.env.server (copy .env.server.example and fill it in)."; exit 1; }

# No pipes into "grep -q" here: under pipefail a closed pipe can make a successful match look like a failure.
db_running() { [ -n "$(docker ps -q --filter 'name=^wasp-dev-db-relay')" ]; }

# 1. Database: reuse the existing dev container and its data.
if ! db_running; then
  echo "Starting Postgres..."
  mkdir -p "$BUILD"
  (cd "$BUILD" && nohup wasp start db > "$HOME/relay-build/db.log" 2>&1 &)
  for _ in $(seq 1 45); do db_running && break; sleep 2; done
  db_running || { echo "Postgres did not start. See $HOME/relay-build/db.log"; exit 1; }
fi

# 2. Public HTTPS tunnel to the dev server (port 3000 forwards /api, /operations and /health to the Wasp server).
docker rm -f "$TUNNEL" >/dev/null 2>&1 || true
docker run -d --rm --name "$TUNNEL" cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://host.docker.internal:3000 >/dev/null
trap 'docker rm -f "$TUNNEL" >/dev/null 2>&1 || true' EXIT
URL=""
for _ in $(seq 1 45); do
  URL="$(docker logs "$TUNNEL" 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 2
done
[ -n "$URL" ] || { echo "The tunnel did not start. See: docker logs $TUNNEL"; exit 1; }

# 3. ElevenLabs: point the save_work_order webhook at this URL (also creates the secret, tool and agent if missing).
(cd "$APP_SRC" && node scripts/elevenlabs-setup.mjs --env "$APP_SRC/.env.server" --public-url "$URL")

# 4. Copy source and env to the build folder; the pages call the API on the public origin.
mkdir -p "$BUILD"
rsync -a --delete --exclude node_modules --exclude .wasp --exclude .env.client "$APP_SRC/" "$BUILD/"
printf 'REACT_APP_API_URL=%s\n' "$URL" > "$BUILD/.env.client"
chmod 600 "$BUILD/.env.server"

cat <<EOF

  Relay is starting. When you see "Server listening on port 3001":

    Student page:        $URL/
    Operator dashboard:  $URL/operator      (PIN = OPERATOR_PIN in dashboard/.env.server)
    No-voice fallback:   $URL/?test=1

  Stop with Ctrl+C. Do not share the URL after the demo: anyone with it can start voice sessions.

EOF

# 5. The app, in the foreground.
cd "$BUILD"
wasp start
