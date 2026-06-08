#!/usr/bin/env bash
# Restore a .dump or .sql backup into Postgres (drops and recreates the target DB).
#
# Usage:
#   ./scripts/restore-postgres.sh backups/ei_pg_backup_YYYYMMDD_HHMMSS.dump
#   ./scripts/restore-postgres.sh backups/ei_pg_backup_YYYYMMDD_HHMMSS.dump --force
#   POSTGRES_CONTAINER=sprdlx_postgres_temp ./scripts/restore-postgres.sh /path/to/backup.dump --force

set -euo pipefail

resolve_postgres_container() {
  if [[ -n "${POSTGRES_CONTAINER:-}" ]]; then
    echo "$POSTGRES_CONTAINER"
    return
  fi
  for c in sprdlx_postgres_temp orders_postgres; do
    if docker inspect "$c" >/dev/null 2>&1; then
      echo "$c"
      return
    fi
  done
  echo ""
}

CONTAINER="$(resolve_postgres_container)"
FORCE=0

usage() {
  echo "Usage: $0 <backup.sql|backup.dump> [--force]" >&2
  exit 1
}

if [[ $# -lt 1 ]]; then
  usage
fi

BACKUP_PATH="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|-f)
      FORCE=1
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      ;;
  esac
  shift
done

if [[ ! -f "$BACKUP_PATH" ]]; then
  echo "Backup not found: $BACKUP_PATH" >&2
  exit 1
fi

if [[ -z "$CONTAINER" ]]; then
  echo "No Postgres container running (tried: sprdlx_postgres_temp, orders_postgres)." >&2
  echo "Remote: cd sprdlx && docker compose up -d db" >&2
  echo "Local:  cd ei-website-backend && docker compose up -d db" >&2
  exit 1
fi

echo "Using Postgres container: $CONTAINER"

user="$(docker exec "$CONTAINER" printenv POSTGRES_USER 2>/dev/null | head -n1 | tr -d '\r')"
db="$(docker exec "$CONTAINER" printenv POSTGRES_DB 2>/dev/null | head -n1 | tr -d '\r')"

if [[ -z "$user" || -z "$db" ]]; then
  echo "Could not read POSTGRES_USER / POSTGRES_DB from container '$CONTAINER'." >&2
  exit 1
fi

if [[ "$FORCE" -ne 1 ]]; then
  echo "WARNING: This will DROP database '$db' and restore from:"
  echo "  $BACKUP_PATH"
  read -r -p "Type YES to continue: " confirm
  if [[ "$confirm" != "YES" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

ext="${BACKUP_PATH##*.}"
ext_lower="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"

echo "Dropping and recreating database '$db' ..."
docker exec "$CONTAINER" psql -U "$user" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE);"
docker exec "$CONTAINER" psql -U "$user" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$db\" OWNER \"$user\";"

if [[ "$ext_lower" == "dump" ]]; then
  remote="/tmp/restore.dump"
  docker cp "$BACKUP_PATH" "${CONTAINER}:${remote}"
  docker exec "$CONTAINER" pg_restore -U "$user" -d "$db" --no-owner --no-acl --clean --if-exists "$remote"
  docker exec "$CONTAINER" rm -f "$remote"b v
elif [[ "$ext_lower" == "sql" ]]; then
  docker exec -i "$CONTAINER" psql -U "$user" -d "$db" -v ON_ERROR_STOP=1 < "$BACKUP_PATH"
else
  echo "Use a .sql or .dump file (pg_dump custom format)." >&2
  exit 1
fi

echo "Restore finished into '$db' on container '$CONTAINER'."
