#!/bin/sh
set -e

PORT="${PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/v1/health"
# How many seconds to wait for the server to become healthy (default 600s = 10min)
MAX_ATTEMPTS="${MAX_ATTEMPTS:-600}"

# Run seed first so tables exist before the server accepts requests (avoids "relation users does not exist").
# db.sync({ alter: true }) in seed.js creates/alters tables; then server can safely run.
echo "Running database sync and seed..."
# node seed.js
# node cleanData.js --yes

echo "Starting server..."
npm run pm2:runtime &
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
