#!/usr/bin/env bash
# Full Postgres backup via Docker container (host) or direct pg_dump (app container / local).
# Writes .sql (plain) + .dump (custom format) under ei-website-backend/backups/
#
# Usage (host — uses docker exec into orders_postgres):
#   ./scripts/backup-postgres.sh
#   POSTGRES_CONTAINER=my_db ./scripts/backup-postgres.sh
#
# Usage (inside orders_app — no Docker CLI; connects to db service):
#   docker exec orders_app npm run db:backup

set -euo pipefail

CONTAINER="${POSTGRES_CONTAINER:-orders_postgres}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="$BACKEND_DIR/backups"

mkdir -p "$BACKUP_DIR"

backup_via_docker() {
  local user db ts sql_host dump_host
  user="$(docker exec "$CONTAINER" printenv POSTGRES_USER 2>/dev/null | head -n1 | tr -d '\r')"
  db="$(docker exec "$CONTAINER" printenv POSTGRES_DB 2>/dev/null | head -n1 | tr -d '\r')"

  if [[ -z "$user" || -z "$db" ]]; then
    echo "Could not read POSTGRES_USER / POSTGRES_DB from container '$CONTAINER'." >&2
    exit 1
  fi

  ts="$(date +%Y%m%d_%H%M%S)"
  sql_host="$BACKUP_DIR/ei_pg_backup_${ts}.sql"
  dump_host="$BACKUP_DIR/ei_pg_backup_${ts}.dump"

  echo "Backing up database '$db' as user '$user' from container '$CONTAINER' ..."

  docker exec "$CONTAINER" pg_dump -U "$user" -d "$db" --no-owner --no-acl -f /tmp/backup.sql
  docker exec "$CONTAINER" pg_dump -U "$user" -d "$db" --no-owner --no-acl -Fc -f /tmp/backup.dump

  docker cp "${CONTAINER}:/tmp/backup.sql" "$sql_host"
  docker cp "${CONTAINER}:/tmp/backup.dump" "$dump_host"
  docker exec "$CONTAINER" rm -f /tmp/backup.sql /tmp/backup.dump

  ls -lh "$sql_host" "$dump_host"
  echo ""
  echo "Done. Restore instructions: backups/RESTORE.md"
}

backup_via_network() {
  local user db pghost pgport ts sql_host dump_host
  user="${POSTGRES_USER:-}"
  db="${POSTGRES_DB:-}"
  pghost="${PM2_POSTGRES_HOST:-${POSTGRES_HOST:-db}}"
  pgport="${POSTGRES_PORT:-5432}"

  if [[ -z "$user" || -z "$db" ]]; then
    echo "POSTGRES_USER and POSTGRES_DB must be set for network backup." >&2
    exit 1
  fi
  if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
    echo "POSTGRES_PASSWORD must be set for network backup." >&2
    exit 1
  fi
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "pg_dump not found. Run from host (docker compose) or install postgresql-client." >&2
    exit 1
  fi

  export PGPASSWORD="$POSTGRES_PASSWORD"

  ts="$(date +%Y%m%d_%H%M%S)"
  sql_host="$BACKUP_DIR/ei_pg_backup_${ts}.sql"
  dump_host="$BACKUP_DIR/ei_pg_backup_${ts}.dump"

  echo "Backing up database '$db' as user '$user' via ${pghost}:${pgport} ..."

  pg_dump -h "$pghost" -p "$pgport" -U "$user" -d "$db" --no-owner --no-acl -f "$sql_host"
  pg_dump -h "$pghost" -p "$pgport" -U "$user" -d "$db" --no-owner --no-acl -Fc -f "$dump_host"

  ls -lh "$sql_host" "$dump_host"
  echo ""
  echo "Done. Restore instructions: backups/RESTORE.md"
}

use_docker=0
if command -v docker >/dev/null 2>&1 && docker inspect "$CONTAINER" >/dev/null 2>&1; then
  state="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
  if [[ "$state" == "true" ]]; then
    use_docker=1
  else
    echo "Container exists but is not running: $CONTAINER" >&2
    echo "Start DB: cd $BACKEND_DIR && docker compose up -d db" >&2
    exit 1
  fi
fi

if [[ "$use_docker" -eq 1 ]]; then
  backup_via_docker
else
  if ! command -v docker >/dev/null 2>&1; then
    backup_via_network
  else
    echo "Container not found: $CONTAINER" >&2
    echo "Start stack: cd $BACKEND_DIR && docker compose up -d" >&2
    echo "Or set POSTGRES_* and run pg_dump directly (see backup_via_network in this script)." >&2
    exit 1
  fi
fi
