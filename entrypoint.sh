#!/bin/sh
set -e

PORT="${PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/v1/health"
MAX_ATTEMPTS=60

# Start the server in the background
npm run dev &
PID=$!

# Wait for the server to become healthy
echo "Waiting for server at ${HEALTH_URL}..."
i=0
while [ $i -lt $MAX_ATTEMPTS ]; do
  if curl -s -f "$HEALTH_URL" > /dev/null 2>&1; then
    echo "Server is healthy. Running seed..."
    node seed.js
    wait $PID
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "Server did not become healthy in time."
kill $PID 2>/dev/null || true
exit 1
