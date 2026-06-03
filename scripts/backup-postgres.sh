#!/usr/bin/env bash
# Full Postgres backup via Docker container (default: orders_postgres from docker-compose.yml).
# Writes .sql (plain) + .dump (custom format) under ei-website-backend/backups/
#
# Usage:
#   ./scripts/backup-postgres.sh
#   POSTGRES_CONTAINER=my_db ./scripts/backup-postgres.sh

set -euo pipefail

CONTAINER="${POSTGRES_CONTAINER:-orders_postgres}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="$BACKEND_DIR/backups"

mkdir -p "$BACKUP_DIR"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Container not running: $CONTAINER" >&2
  echo "Start DB: cd $BACKEND_DIR && docker compose up -d db" >&2
  exit 1
fi

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