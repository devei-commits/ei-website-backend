#!/usr/bin/env bash
# Restore a .dump or .sql backup (drops and recreates target DB).
#
# Uses DATABASE_URL from .env (RDS) or local Docker Postgres container.
#
#   ./scripts/restore-postgres.sh backups/ei_pg_backup_YYYYMMDD.dump --force

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=pg-client.sh
source "$SCRIPT_DIR/pg-client.sh"

load_pg_conn() {
  local env_file="$BACKEND_DIR/.env"
  [[ -f "$env_file" ]] || { echo ".env not found" >&2; return 1; }
  eval "$(node -e "
    const fs = require('fs');
    const env = {};
    const envFile = '$env_file';
    if (fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, 'utf8').split(/\\r?\\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i <= 0) continue;
        let v = t.slice(i + 1).trim();
        if ((v.startsWith('\"') && v.endsWith('\"')) || (v.startsWith(\"'\") && v.endsWith(\"'\"))) v = v.slice(1, -1);
        env[t.slice(0, i).trim()] = v;
      }
    }
    for (const k of ['DATABASE_URL', 'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    const raw = env.DATABASE_URL || '';
    let host, port, user, password, database;
    if (raw) {
      const u = new URL(raw.replace(/^postgresql:/i, 'postgres:'));
      host = u.hostname; port = u.port || '5432';
      user = decodeURIComponent(u.username);
      password = decodeURIComponent(u.password);
      database = decodeURIComponent(u.pathname.replace(/^\\//, ''));
    } else {
      host = env.POSTGRES_HOST || 'db';
      port = env.POSTGRES_PORT || '5432';
      user = env.POSTGRES_USER || '';
      password = env.POSTGRES_PASSWORD || '';
      database = env.POSTGRES_DB || '';
    }
    if (!host || !user || !database) process.exit(2);
    const q = (s) => \"'\" + String(s).replace(/'/g, \"'\\\\''\") + \"'\";
    const ssl = raw.includes('rds.amazonaws.com') || raw.includes('sslmode=require') ? '1' : '0';
    console.log('PGHOST=' + q(host));
    console.log('PGPORT=' + q(port));
    console.log('PGUSER=' + q(user));
    console.log('PGPASSWORD=' + q(password));
    console.log('PGDATABASE=' + q(database));
    console.log('PG_USE_SSL=' + q(ssl));
  ")"
}

resolve_container() {
  for c in sprdlx_postgres_temp orders_postgres; do
    docker inspect "$c" >/dev/null 2>&1 && echo "$c" && return
  done
  echo ""
}

resolve_mode() {
  CONTAINER="$(resolve_container)"
  MODE="network"
  if ! command -v docker >/dev/null 2>&1 || [[ -z "$CONTAINER" ]]; then
    return
  fi
  docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true || return
  case "${PGHOST}" in
    db|localhost|127.0.0.1) MODE="docker" ;;
  esac
}

require_network_pg_client() {
  local tool="$1"
  command -v "$tool" >/dev/null 2>&1 && return 0
  install_postgres_client && command -v "$tool" >/dev/null 2>&1 && return 0
  if [[ -f /.dockerenv ]]; then
    echo "postgresql-client-16 missing inside orders_app. Run from the Mac host instead:" >&2
    echo "  npm run db:restore -- <backup> --force" >&2
  elif [[ -n "${CONTAINER:-}" ]]; then
    echo "Run from the Mac host (not docker exec orders_app):" >&2
    echo "  npm run db:restore -- <backup> --force" >&2
  else
    echo "Install postgresql-client-16 or start Docker Postgres (docker compose up -d db)" >&2
  fi
  return 1
}

# Cannot DROP DATABASE postgres while connected to postgres — use template1 instead.
admin_database() {
  local target="$1"
  if [[ "$target" == "postgres" ]]; then
    echo "template1"
  else
    echo "postgres"
  fi
}

recreate_database_docker() {
  local container="$1" user="$2" db="$3"
  local admin_db
  admin_db="$(admin_database "$db")"
  docker exec "$container" psql -U "$user" -d "$admin_db" -v ON_ERROR_STOP=1 -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid();"
  docker exec "$container" psql -U "$user" -d "$admin_db" -v ON_ERROR_STOP=1 -c \
    "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE);"
  docker exec "$container" psql -U "$user" -d "$admin_db" -v ON_ERROR_STOP=1 -c \
    "CREATE DATABASE \"$db\" OWNER \"$user\";"
}

recreate_database_network() {
  local db="$1" user="$2"
  local admin_db
  admin_db="$(admin_database "$db")"
  psql -h "$PGHOST" -p "$PGPORT" -U "$user" -d "$admin_db" -v ON_ERROR_STOP=1 -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid();"
  psql -h "$PGHOST" -p "$PGPORT" -U "$user" -d "$admin_db" -v ON_ERROR_STOP=1 -c \
    "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE);"
  psql -h "$PGHOST" -p "$PGPORT" -U "$user" -d "$admin_db" -v ON_ERROR_STOP=1 -c \
    "CREATE DATABASE \"$db\" OWNER \"$user\";"
}

FORCE=0
[[ $# -ge 1 ]] || { echo "Usage: $0 <backup.dump|backup.sql> [--force]" >&2; exit 1; }
BACKUP_PATH="$1"; shift
for arg in "$@"; do [[ "$arg" == "--force" || "$arg" == "-f" ]] && FORCE=1; done
[[ -f "$BACKUP_PATH" ]] || { echo "Backup not found: $BACKUP_PATH" >&2; exit 1; }

load_pg_conn
resolve_mode

ext_lower="$(printf '%s' "${BACKUP_PATH##*.}" | tr '[:upper:]' '[:lower:]')"
[[ "$ext_lower" == "dump" || "$ext_lower" == "sql" ]] || { echo "Use .dump or .sql" >&2; exit 1; }

if [[ "$FORCE" -ne 1 ]]; then
  echo "WARNING: DROP database and restore from $BACKUP_PATH"
  read -r -p "Type YES to continue: " confirm
  [[ "$confirm" == "YES" ]] || { echo "Aborted."; exit 0; }
fi

restore_flags=(--no-owner --no-acl --no-privileges)

if [[ "$MODE" == "docker" ]]; then
  user="$(docker exec "$CONTAINER" printenv POSTGRES_USER | tr -d '\r')"
  db="$(docker exec "$CONTAINER" printenv POSTGRES_DB | tr -d '\r')"
  recreate_database_docker "$CONTAINER" "$user" "$db"
  if [[ "$ext_lower" == "dump" ]]; then
    docker cp "$BACKUP_PATH" "${CONTAINER}:/tmp/restore.dump"
    docker exec "$CONTAINER" pg_restore -U "$user" -d "$db" "${restore_flags[@]}" --clean --if-exists /tmp/restore.dump
    docker exec "$CONTAINER" rm -f /tmp/restore.dump
  else
    docker exec -i "$CONTAINER" psql -U "$user" -d "$db" -v ON_ERROR_STOP=1 < "$BACKUP_PATH"
  fi
  echo "Restore finished on $CONTAINER."
else
  require_network_pg_client psql || exit 1
  [[ "$PG_USE_SSL" == "1" ]] && export PGSSLMODE=require
  export PGPASSWORD
  recreate_database_network "$PGDATABASE" "$PGUSER"
  if [[ "$ext_lower" == "dump" ]]; then
    require_network_pg_client pg_restore || exit 1
    pg_restore -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
      "${restore_flags[@]}" --clean --if-exists "$BACKUP_PATH" || true
  else
    psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -f "$BACKUP_PATH"
  fi
  echo "Restore finished at ${PGHOST}:${PGPORT}/${PGDATABASE}."
fi
