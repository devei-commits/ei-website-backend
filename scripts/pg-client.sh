#!/usr/bin/env bash
# Postgres client tools for backup/restore. The prod server is PG17, and pg_dump must be >= the
# server major (an older pg_dump aborts with "server version mismatch"), so backup needs client 17+.
# Restore may require client 18+ when the dump uses a newer custom format (e.g. v1.16 from PG17+ pg_dump).

PG_CLIENT_MIN_MAJOR="${PG_CLIENT_MIN_MAJOR:-17}"
PG_CLIENT_RESTORE_MIN_MAJOR="${PG_CLIENT_RESTORE_MIN_MAJOR:-18}"

pg_client_major() {
  command -v pg_dump >/dev/null 2>&1 || return 1
  pg_dump --version | sed -n 's/.* \([0-9]\+\).*/\1/p'
}

install_postgres_client() {
  local min_major="${1:-$PG_CLIENT_MIN_MAJOR}"
  local major
  major="$(pg_client_major || true)"
  if [[ -n "${major:-}" && "$major" -ge "$min_major" ]]; then
    return 0
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    return 1
  fi

  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg

  if [[ ! -f /etc/apt/sources.list.d/pgdg.list ]]; then
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list
    apt-get update -qq
  fi

  local pkg=""
  if apt-cache show "postgresql-client-${min_major}" >/dev/null 2>&1; then
    pkg="postgresql-client-${min_major}"
  elif [[ "$min_major" -ge 18 ]] && apt-cache show postgresql-client-18 >/dev/null 2>&1; then
    pkg="postgresql-client-18"
  elif apt-cache show postgresql-client-16 >/dev/null 2>&1; then
    pkg="postgresql-client-16"
  fi
  [[ -n "$pkg" ]] || return 1
  apt-get install -y -qq "$pkg"

  major="$(pg_client_major || true)"
  [[ -n "${major:-}" && "$major" -ge "$min_major" ]]
}

ensure_pg_client() {
  install_postgres_client "$PG_CLIENT_MIN_MAJOR" && return 0
  pg_client_install_hint
  return 1
}

ensure_pg_restore_client() {
  install_postgres_client "$PG_CLIENT_RESTORE_MIN_MAJOR" && return 0
  pg_client_install_hint restore
  return 1
}

pg_client_install_hint() {
  local mode="${1:-backup}"
  if [[ -f /.dockerenv ]]; then
    echo "postgresql-client-${PG_CLIENT_RESTORE_MIN_MAJOR} missing inside orders_app. Run from the Mac host instead:" >&2
    echo "  npm run db:${mode} -- <backup>" >&2
  elif [[ -n "${CONTAINER:-}" ]]; then
    echo "Run from the Mac host: npm run db:${mode}" >&2
  else
    echo "Install postgresql-client-${PG_CLIENT_RESTORE_MIN_MAJOR} or start Docker Postgres (docker compose up -d db)" >&2
  fi
}

run_pg_restore() {
  local backup_path="$1"
  shift
  local log code
  log="$(mktemp)"
  set +e
  pg_restore -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    "$@" --clean --if-exists "$backup_path" >"$log" 2>&1
  code=$?
  set -e
  cat "$log"
  if [[ "$code" -eq 0 ]]; then
    rm -f "$log"
    return 0
  fi
  if grep -q 'unsupported version' "$log"; then
    echo "pg_restore client is too old for this dump. Need postgresql-client-${PG_CLIENT_RESTORE_MIN_MAJOR}+." >&2
    rm -f "$log"
    return 1
  fi
  if grep -q 'transaction_timeout' "$log" && ! grep -qiE 'FATAL|could not connect|unsupported version' "$log"; then
    echo "Warning: dump contains PG17+ session settings ignored on PG16 (transaction_timeout)." >&2
    rm -f "$log"
    return 0
  fi
  rm -f "$log"
  return "$code"
}
