#!/bin/sh
# Restore Postgres from backups/ before the API starts (Docker app container → db service).
#
# Env:
#   DB_AUTO_RESTORE     off | if_empty (default) | always
#   DB_BACKUP_FILE      Path to .dump or .sql (default: newest backups/*.dump)
#   PM2_POSTGRES_HOST   Postgres host (default: db)
#   POSTGRES_HOST       Fallback host
#   POSTGRES_PORT       Port (default: 5432)
#   POSTGRES_USER       Required
#   POSTGRES_PASSWORD   Required
#   POSTGRES_DB         Required

set -eu

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="$(printf '%s' "${DB_AUTO_RESTORE:-if_empty}" | tr '[:upper:]' '[:lower:]')"

case "$MODE" in
  off | 0 | false | no | skip)
    echo "[db-auto-restore] Disabled (DB_AUTO_RESTORE=$MODE)."
    exit 0
  ;;
  always | force | yes)
    MODE=always
  ;;
  if_empty | 1 | true | on | "")
    MODE=if_empty
  ;;
  *)
    echo "[db-auto-restore] Unknown DB_AUTO_RESTORE='$MODE' (use off, if_empty, or always)." >&2
    exit 1
  ;;
esac

PGHOST="${PM2_POSTGRES_HOST:-${POSTGRES_HOST:-db}}"
PGPORT="${POSTGRES_PORT:-5432}"
PGUSER="${POSTGRES_USER:-}"
PGDATABASE="${POSTGRES_DB:-}"

if [ -z "$PGUSER" ] || [ -z "$PGDATABASE" ]; then
  echo "[db-auto-restore] POSTGRES_USER and POSTGRES_DB must be set." >&2
  exit 1
fi

if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "[db-auto-restore] POSTGRES_PASSWORD must be set." >&2
  exit 1
fi

export PGPASSWORD="$POSTGRES_PASSWORD"

BACKUP_FILE="${DB_BACKUP_FILE:-}"
if [ -z "$BACKUP_FILE" ]; then
  BACKUP_FILE="$(ls -t "$APP_ROOT"/backups/*.dump 2>/dev/null | head -n 1 || true)"
fi

if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "[db-auto-restore] No backup file found (set DB_BACKUP_FILE or add backups/*.dump). Skipping."
  exit 0
fi

case "$(printf '%s' "${BACKUP_FILE##*.}" | tr '[:upper:]' '[:lower:]')" in
  dump) RESTORE_KIND=dump ;;
  sql) RESTORE_KIND=sql ;;
  *)
    echo "[db-auto-restore] Unsupported backup type (use .dump or .sql): $BACKUP_FILE" >&2
    exit 1
  ;;
esac

if ! command -v pg_isready >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
  echo "[db-auto-restore] postgresql-client not installed (pg_isready/psql missing)." >&2
  exit 1
fi

echo "[db-auto-restore] Waiting for Postgres at ${PGHOST}:${PGPORT} ..."
attempts=0
max_attempts="${DB_WAIT_MAX_ATTEMPTS:-60}"
while [ "$attempts" -lt "$max_attempts" ]; do
  if pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -q 2>/dev/null; then
    break
  fi
  attempts=$((attempts + 1))
  sleep 1
done

if ! pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -q 2>/dev/null; then
  echo "[db-auto-restore] Postgres not ready after ${max_attempts}s." >&2
  exit 1
fi

db_exists="$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$PGDATABASE' LIMIT 1;" 2>/dev/null | tr -d '[:space:]' || true)"

table_count=0
if [ "$db_exists" = "1" ]; then
  table_count="$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -tAc \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';" \
    2>/dev/null | tr -d '[:space:]' || echo 0)"
fi

if [ "$MODE" = "if_empty" ] && [ "$db_exists" = "1" ] && [ "${table_count:-0}" -gt 0 ]; then
  echo "[db-auto-restore] Database '$PGDATABASE' already has ${table_count} table(s); skipping (DB_AUTO_RESTORE=if_empty)."
  exit 0
fi

echo "[db-auto-restore] Restoring '$PGDATABASE' from $(basename "$BACKUP_FILE") (mode=$MODE) ..."

if [ "$db_exists" = "1" ]; then
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$PGDATABASE\" WITH (FORCE);"
fi

psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$PGDATABASE\" OWNER \"$PGUSER\";"

restore_sql_file() {
  sql_path="$1"
  echo "[db-auto-restore] Applying SQL backup $(basename "$sql_path") ..."
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -f "$sql_path"
}

count_public_tables() {
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -tAc \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';" \
    2>/dev/null | tr -d '[:space:]'
}

if [ "$RESTORE_KIND" = "dump" ]; then
  if ! command -v pg_restore >/dev/null 2>&1; then
    echo "[db-auto-restore] pg_restore not found." >&2
    exit 1
  fi
  set +e
  pg_restore -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    --no-owner --no-acl --clean --if-exists "$BACKUP_FILE" 2> /tmp/pg_restore.err
  restore_exit=$?
  set -e
  table_count="$(count_public_tables || echo 0)"
  if [ "${table_count:-0}" -eq 0 ]; then
    sql_fallback="${BACKUP_FILE%.dump}.sql"
    if [ -f "$sql_fallback" ]; then
      echo "[db-auto-restore] pg_restore failed (exit $restore_exit); trying SQL fallback ..."
      cat /tmp/pg_restore.err 2>/dev/null || true
      restore_sql_file "$sql_fallback"
      table_count="$(count_public_tables || echo 0)"
    fi
  fi
  if [ "${table_count:-0}" -eq 0 ]; then
    echo "[db-auto-restore] Restore failed and no tables were created." >&2
    cat /tmp/pg_restore.err 2>/dev/null || true
    exit 1
  fi
  if [ "$restore_exit" -ne 0 ]; then
    echo "[db-auto-restore] pg_restore reported warnings (exit $restore_exit); ${table_count} table(s) present — continuing."
  fi
else
  restore_sql_file "$BACKUP_FILE"
fi

echo "[db-auto-restore] Restore finished."
