#!/usr/bin/env bash
# Restore a .dump or .sql backup into Postgres (drops and recreates the target DB).
#
# Target is chosen from ei-website-backend/.env:
#   - DATABASE_URL → RDS / remote / host tunnel (psql + pg_restore on this machine)
#   - host `db` + running sprdlx_postgres_temp / orders_postgres → docker exec restore
#
# Usage:
#   ./scripts/restore-postgres.sh backups/ei_pg_backup_YYYYMMDD_HHMMSS.dump
#   ./scripts/restore-postgres.sh backups/ei_pg_backup_YYYYMMDD_HHMMSS.dump --force
#   POSTGRES_RESTORE_VIA=network ./scripts/restore-postgres.sh backups/foo.dump --force
#   POSTGRES_CONTAINER=sprdlx_postgres_temp ./scripts/restore-postgres.sh /path/to/backup.dump --force

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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

load_pg_conn_from_env() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required to read DATABASE_URL from .env." >&2
    return 1
  fi
  eval "$(
    cd "$BACKEND_DIR" && node -e "
      const dotenv = require('dotenv');
      dotenv.config({ path: '.env' });
      const esc = (value) => \"'\" + String(value ?? '').replace(/'/g, \"'\\\\''\") + \"'\";
      let host = '';
      let port = '5432';
      let user = '';
      let password = '';
      let database = '';
      const rawUrl = process.env.DATABASE_URL || '';
      if (rawUrl) {
        const parsed = new URL(rawUrl.replace(/^postgresql:/i, 'postgres:'));
        host = parsed.hostname;
        port = parsed.port || '5432';
        user = decodeURIComponent(parsed.username);
        password = decodeURIComponent(parsed.password);
        database = decodeURIComponent(parsed.pathname.replace(/^\\//, ''));
      } else {
        host = process.env.PM2_POSTGRES_HOST || process.env.POSTGRES_HOST || '';
        port = process.env.POSTGRES_PORT || '5432';
        user = process.env.POSTGRES_USER || '';
        password = process.env.POSTGRES_PASSWORD || '';
        database = process.env.POSTGRES_DB || '';
      }
      if (!host || !user || !database) {
        process.exit(2);
      }
      console.log('PGHOST=' + esc(host));
      console.log('PGPORT=' + esc(port));
      console.log('PGUSER=' + esc(user));
      console.log('PGPASSWORD=' + esc(password));
      console.log('PGDATABASE=' + esc(database));
      console.log('PG_USE_SSL=' + esc(
        rawUrl.includes('rds.amazonaws.com') || rawUrl.includes('sslmode=require') ? '1' : '0'
      ));
    "
  )"
}

resolve_restore_mode() {
  local container="$1"
  local via="${POSTGRES_RESTORE_VIA:-}"

  if [[ "$via" == "network" ]]; then
    echo "network"
    return
  fi
  if [[ "$via" == "docker" ]]; then
    echo "docker"
    return
  fi

  if [[ -n "${DATABASE_URL:-}" ]] && [[ "${PGHOST:-}" != "db" ]]; then
    echo "network"
    return
  fi

  if [[ -n "$container" ]] && docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
    echo "docker"
    return
  fi

  if [[ -n "${PGHOST:-}" ]]; then
    echo "network"
    return
  fi

  echo ""
}

require_network_client() {
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql not found. Install postgresql-client (e.g. sudo apt install postgresql-client)." >&2
    exit 1
  fi
  if [[ "$1" == "dump" ]] && ! command -v pg_restore >/dev/null 2>&1; then
    echo "pg_restore not found. Install postgresql-client." >&2
    exit 1
  fi
}

configure_ssl() {
  if [[ "${PG_USE_SSL:-0}" == "1" ]]; then
    export PGSSLMODE="${PGSSLMODE:-require}"
  fi
}

drop_and_create_db_network() {
  export PGPASSWORD
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$PGDATABASE\" WITH (FORCE);"
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$PGDATABASE\" OWNER \"$PGUSER\";"
}

count_public_tables_network() {
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -tAc \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';" \
    2>/dev/null | tr -d '[:space:]'
}

restore_dump_network() {
  local backup_path="$1"
  set +e
  pg_restore -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    --no-owner --no-acl --clean --if-exists "$backup_path" 2> /tmp/pg_restore.err
  local restore_exit=$?
  set -e
  local table_count
  table_count="$(count_public_tables_network || echo 0)"
  if [[ "${table_count:-0}" -eq 0 ]]; then
    local sql_fallback="${backup_path%.dump}.sql"
    if [[ -f "$sql_fallback" ]]; then
      echo "pg_restore failed (exit $restore_exit); trying SQL fallback ..."
      cat /tmp/pg_restore.err 2>/dev/null || true
      psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -f "$sql_fallback"
      table_count="$(count_public_tables_network || echo 0)"
    fi
  fi
  if [[ "${table_count:-0}" -eq 0 ]]; then
    echo "Restore failed and no tables were created." >&2
    cat /tmp/pg_restore.err 2>/dev/null || true
    exit 1
  fi
  if [[ "$restore_exit" -ne 0 ]]; then
    echo "pg_restore reported warnings (exit $restore_exit); ${table_count} table(s) present — continuing."
  fi
}

restore_via_network() {
  local backup_path="$1"
  local ext_lower="$2"

  require_network_client "$ext_lower"
  configure_ssl
  export PGPASSWORD

  echo "Restoring into '$PGDATABASE' at ${PGHOST}:${PGPORT} (from .env DATABASE_URL) ..."
  drop_and_create_db_network

  if [[ "$ext_lower" == "dump" ]]; then
    restore_dump_network "$backup_path"
  else
    psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -f "$backup_path"
  fi

  echo "Restore finished into '$PGDATABASE' at ${PGHOST}:${PGPORT}."
}

restore_via_docker() {
  local container="$1"
  local backup_path="$2"
  local ext_lower="$3"

  echo "Using Postgres container: $CONTAINER"

  local user db
  user="$(docker exec "$container" printenv POSTGRES_USER 2>/dev/null | head -n1 | tr -d '\r')"
  db="$(docker exec "$container" printenv POSTGRES_DB 2>/dev/null | head -n1 | tr -d '\r')"

  if [[ -z "$user" || -z "$db" ]]; then
    echo "Could not read POSTGRES_USER / POSTGRES_DB from container '$container'." >&2
    exit 1
  fi

  echo "Dropping and recreating database '$db' ..."
  docker exec "$container" psql -U "$user" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE);"
  docker exec "$container" psql -U "$user" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$db\" OWNER \"$user\";"

  if [[ "$ext_lower" == "dump" ]]; then
    local remote="/tmp/restore.dump"
    docker cp "$backup_path" "${container}:${remote}"
    docker exec "$container" pg_restore -U "$user" -d "$db" --no-owner --no-acl --clean --if-exists "$remote"
    docker exec "$container" rm -f "$remote"
  else
    docker exec -i "$container" psql -U "$user" -d "$db" -v ON_ERROR_STOP=1 < "$backup_path"
  fi

  echo "Restore finished into '$db' on container '$container'."
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

if [[ -f "$BACKEND_DIR/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$BACKEND_DIR/.env"
  set +a
fi

if ! load_pg_conn_from_env; then
  echo "Could not resolve Postgres connection from $BACKEND_DIR/.env (set DATABASE_URL or POSTGRES_*)." >&2
  exit 1
fi

MODE="$(resolve_restore_mode "$CONTAINER")"
if [[ -z "$MODE" ]]; then
  echo "No Postgres target found." >&2
  echo "Set DATABASE_URL in .env for RDS, or start docker compose db for local restore." >&2
  exit 1
fi

TARGET_LABEL="$PGDATABASE @ ${PGHOST}:${PGPORT}"
if [[ "$MODE" == "docker" ]]; then
  TARGET_LABEL="$(docker exec "$CONTAINER" printenv POSTGRES_DB 2>/dev/null | head -n1 | tr -d '\r') on $CONTAINER"
fi

if [[ "$FORCE" -ne 1 ]]; then
  echo "WARNING: This will DROP the target database and restore from:"
  echo "  $BACKUP_PATH"
  echo "Target: $TARGET_LABEL (mode=$MODE)"
  read -r -p "Type YES to continue: " confirm
  if [[ "$confirm" != "YES" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

ext="${BACKUP_PATH##*.}"
ext_lower="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"

if [[ "$ext_lower" != "dump" && "$ext_lower" != "sql" ]]; then
  echo "Use a .sql or .dump file (pg_dump custom format)." >&2
  exit 1
fi

if [[ "$MODE" == "network" ]]; then
  restore_via_network "$BACKUP_PATH" "$ext_lower"
else
  restore_via_docker "$CONTAINER" "$BACKUP_PATH" "$ext_lower"
fi
