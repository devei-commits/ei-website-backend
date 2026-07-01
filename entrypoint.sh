#!/bin/sh
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/v1/health"
# How many seconds to wait for the server to become healthy (default 600s = 10min)
MAX_ATTEMPTS="${MAX_ATTEMPTS:-600}"

ensure_pg_client() {
  if sh "$APP_DIR/scripts/install-pg16-client.sh"; then
    return 0
  fi
  echo "[entrypoint] Could not install PostgreSQL 16 client; DB auto-restore may fail." >&2
  return 1
}

# Restore from backups/*.dump when DB is empty (or always when DB_AUTO_RESTORE=always).
# echo "[entrypoint] Database auto-restore..."
# if ensure_pg_client; then
#   sh "$APP_DIR/scripts/db-auto-restore.sh"
# else
#   echo "[entrypoint] Skipping DB auto-restore (no Postgres client)."
# fi

# Optional: run seed when DB was not restored and seed is enabled.
# node seed.js
# node cleanData.js --yes

echo "Starting server..."
npm run dev &
PID=$!

echo "Waiting for server at ${HEALTH_URL} (up to ${MAX_ATTEMPTS}s)..."
i=0
while [ $i -lt $MAX_ATTEMPTS ]; do
  if curl -s -f "$HEALTH_URL" > /dev/null 2>&1; then
    echo "Server is healthy."
    wait $PID
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "Server did not become healthy within ${MAX_ATTEMPTS}s."
wait $PID
exit 0
