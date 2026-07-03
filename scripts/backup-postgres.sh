#!/usr/bin/env bash
# Backup Postgres to backups/ei_pg_backup_<timestamp>.sql + .dump
# Uses DATABASE_URL from .env (RDS) or local Docker Postgres container.
#
#   ./scripts/backup-postgres.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="$BACKEND_DIR/backups"
# shellcheck source=pg-client.sh
source "$SCRIPT_DIR/pg-client.sh"
mkdir -p "$BACKUP_DIR"

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

load_pg_conn
resolve_mode

ts="$(date +%Y%m%d_%H%M%S)"
sql_host="$BACKUP_DIR/ei_pg_backup_${ts}.sql"
dump_host="$BACKUP_DIR/ei_pg_backup_${ts}.dump"
dump_args=(--no-owner --no-acl)

if [[ "$MODE" == "docker" ]]; then
  user="$(docker exec "$CONTAINER" printenv POSTGRES_USER | tr -d '\r')"
  db="$(docker exec "$CONTAINER" printenv POSTGRES_DB | tr -d '\r')"
  docker exec "$CONTAINER" pg_dump -U "$user" -d "$db" "${dump_args[@]}" -f /tmp/backup.sql
  docker exec "$CONTAINER" pg_dump -U "$user" -d "$db" "${dump_args[@]}" -Fc -f /tmp/backup.dump
  docker cp "${CONTAINER}:/tmp/backup.sql" "$sql_host"
  docker cp "${CONTAINER}:/tmp/backup.dump" "$dump_host"
  docker exec "$CONTAINER" rm -f /tmp/backup.sql /tmp/backup.dump
else
  ensure_pg_client || exit 1
  [[ "$PG_USE_SSL" == "1" ]] && export PGSSLMODE=require
  export PGPASSWORD
  pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "${dump_args[@]}" -f "$sql_host"
  pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "${dump_args[@]}" -Fc -f "$dump_host"
fi

ls -lh "$sql_host" "$dump_host"
echo "Done. Restore: ./scripts/restore-postgres.sh $dump_host --force"
