#!/bin/sh
set -e

PORT="${PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/v1/health"
# How many seconds to wait for the server to become healthy (default 600s = 10min)
MAX_ATTEMPTS="${MAX_ATTEMPTS:-600}"

# Start the server in the background
npm run dev &
PID=$!

echo "Waiting for server at ${HEALTH_URL} (up to ${MAX_ATTEMPTS}s)..."
i=0
while [ $i -lt $MAX_ATTEMPTS ]; do
  if curl -s -f "$HEALTH_URL" > /dev/null 2>&1; then
    echo "Server is healthy. Starting seed in background..."
    node seed.js &
    wait $PID
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "Server did not become healthy within ${MAX_ATTEMPTS}s."
echo "Leaving server running and starting seed in background (will retry/connect when DB available)."
node seed.js &
wait $PID
exit 0
