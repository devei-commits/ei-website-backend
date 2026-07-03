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
    db|localhost|127.0.0.1)
      # Prefer host/network client (often PG18+) — PG16 container pg_restore cannot read newer dumps.
      if command -v pg_restore >/dev/null 2>&1 && command -v psql >/dev/null 2>&1; then
        MODE="network"
      elif [[ -n "$CONTAINER" ]]; then
        MODE="docker"
      fi
      ;;
  esac
}

resolve_backup_kind() {
  local path="$1"
  local ext
  ext="$(printf '%s' "${path##*.}" | tr '[:upper:]' '[:lower:]')"
  if [[ "$ext" == "dump" || "$ext" == "sql" ]]; then
    echo "$ext"
    return 0
  fi
  if command -v file >/dev/null 2>&1; then
    local kind
    kind="$(file -b "$path")"
    if [[ "$kind" == *"PostgreSQL custom database dump"* ]]; then
      echo "dump"
      return 0
    fi
    if [[ "$kind" == *"ASCII text"* || "$kind" == *"Unicode text"* ]]; then
      echo "sql"
      return 0
    fi
  fi
  echo ""
  return 1
}

require_network_pg_client() {
  local tool="$1"
  if [[ "$tool" == "pg_restore" ]]; then
    local major
    major="$(pg_client_major || true)"
    if [[ -n "${major:-}" && "$major" -ge "$PG_CLIENT_RESTORE_MIN_MAJOR" ]]; then
      return 0
    fi
    ensure_pg_restore_client && return 0
    return 1
  fi
  command -v "$tool" >/dev/null 2>&1 && return 0
  install_postgres_client "$PG_CLIENT_MIN_MAJOR" && command -v "$tool" >/dev/null 2>&1 && return 0
  pg_client_install_hint restore
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
[[ $# -ge 1 ]] || { echo "Usage: $0 <backup> [--force]  (.dump, .sql, or extensionless pg dump)" >&2; exit 1; }
BACKUP_PATH="$1"; shift
for arg in "$@"; do [[ "$arg" == "--force" || "$arg" == "-f" ]] && FORCE=1; done
[[ -f "$BACKUP_PATH" ]] || { echo "Backup not found: $BACKUP_PATH" >&2; exit 1; }

load_pg_conn
resolve_mode

backup_kind="$(resolve_backup_kind "$BACKUP_PATH" || true)"
[[ -n "$backup_kind" ]] || { echo "Unrecognized backup (use .dump, .sql, or a PostgreSQL custom dump file)" >&2; exit 1; }

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
  if [[ "$backup_kind" == "dump" ]]; then
    docker cp "$BACKUP_PATH" "${CONTAINER}:/tmp/restore.dump"
    set +e
    docker exec "$CONTAINER" pg_restore -U "$user" -d "$db" "${restore_flags[@]}" --clean --if-exists /tmp/restore.dump
    docker_restore_code=$?
    set -e
    docker exec "$CONTAINER" rm -f /tmp/restore.dump
    if [[ "$docker_restore_code" -ne 0 ]]; then
      echo "Container pg_restore failed; retrying with host/network client..." >&2
      require_network_pg_client pg_restore || exit 1
      [[ "$PG_USE_SSL" == "1" ]] && export PGSSLMODE=require
      export PGPASSWORD
      run_pg_restore "$BACKUP_PATH" "${restore_flags[@]}" || exit 1
    fi
  else
    docker exec -i "$CONTAINER" psql -U "$user" -d "$db" -v ON_ERROR_STOP=1 < "$BACKUP_PATH"
  fi
  echo "Restore finished on $CONTAINER."
else
  require_network_pg_client psql || exit 1
  [[ "$PG_USE_SSL" == "1" ]] && export PGSSLMODE=require
  export PGPASSWORD
  recreate_database_network "$PGDATABASE" "$PGUSER"
  if [[ "$backup_kind" == "dump" ]]; then
    require_network_pg_client pg_restore || exit 1
    run_pg_restore "$BACKUP_PATH" "${restore_flags[@]}" || exit 1
  else
    psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -f "$BACKUP_PATH"
  fi
  echo "Restore finished at ${PGHOST}:${PGPORT}/${PGDATABASE}."
fi
