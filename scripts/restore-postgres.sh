#!/usr/bin/env bash
# Restore a .dump or .sql backup into an EMPTY database (drops DB first).
# Default container: orders_postgres (ei-website-backend/docker-compose.yml). Env in .env
#
# Usage (from anywhere):
#   SPRDLX_ROOT=/path/to/sprdlx ./scripts/restore-postgres.sh backups/ei_pg_backup_20260526_112023.dump
#   ./scripts/restore-postgres.sh backups/ei_pg_backup_20260526_112023.dump --force

set -euo pipefail

BACKUP_PATH="${1:-}"
FORCE="${2:-}"
CONTAINER="${POSTGRES_CONTAINER:-orders_postgres}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SPRDLX_ROOT="${SPRDLX_ROOT:-$(cd "$BACKEND_DIR/.." && pwd)}"
ENV_FILE="${ENV_FILE:-$BACKEND_DIR/.env}"

if [[ -z "$BACKUP_PATH" ]]; then
  echo "Usage: $0 <path-to-backup.dump|.sql> [--force]" >&2
  exit 1
fi

if [[ ! -f "$BACKUP_PATH" ]]; then
  # Allow path relative to backups/
  if [[ -f "$BACKEND_DIR/backups/$BACKUP_PATH" ]]; then
    BACKUP_PATH="$BACKEND_DIR/backups/$BACKUP_PATH"
  else
    echo "Backup not found: $BACKUP_PATH" >&2
    exit 1
  fi
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing .env: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source <(grep -E '^POSTGRES_(USER|DB|PASSWORD)=' "$ENV_FILE" | grep -v '^#')
set +a
export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD not set in .env}"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Container not running: $CONTAINER (start: cd $SPRDLX_ROOT && docker compose up -d db)" >&2
  exit 1
fi

if [[ "$FORCE" != "--force" ]]; then
  echo "WARNING: This will DROP database '$POSTGRES_DB' and restore from:"
  echo "  $BACKUP_PATH"
  read -r -p "Type YES to continue: " confirm
  if [[ "$confirm" != "YES" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

echo "Stopping backend (avoids open connections) ..."
docker compose -f "$SPRDLX_ROOT/docker-compose.yml" stop backend 2>/dev/null || true

echo "Dropping and recreating database $POSTGRES_DB ..."
docker exec -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" \
  psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE);"
docker exec -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" \
  psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"

ext="${BACKUP_PATH##*.}"
ext_lower="$(echo "$ext" | tr '[:upper:]' '[:lower:]')"

if [[ "$ext_lower" == "dump" ]]; then
  docker cp "$BACKUP_PATH" "$CONTAINER:/tmp/restore.dump"
  docker exec -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" \
    pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --clean --if-exists /tmp/restore.dump
  docker exec "$CONTAINER" rm -f /tmp/restore.dump
elif [[ "$ext_lower" == "sql" ]]; then
  docker exec -i -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 <"$BACKUP_PATH"
else
  echo "Use a .dump (custom format) or .sql file." >&2
  exit 1
fi

echo "Restore finished into $POSTGRES_DB on $CONTAINER."
echo "Start API: cd $SPRDLX_ROOT && docker compose up -d backend"
