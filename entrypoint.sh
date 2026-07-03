#!/bin/sh
set -e

if [ -f /usr/src/app/scripts/pg-client.sh ]; then
  # shellcheck source=/dev/null
  . /usr/src/app/scripts/pg-client.sh
  install_postgres_client || true
fi

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/v1/health"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-600}"

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
