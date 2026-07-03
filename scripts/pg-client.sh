#!/usr/bin/env bash
# Ensure pg_dump/psql client matches Postgres 16 server (Debian bookworm ships client 15).

pg_client_major() {
  command -v pg_dump >/dev/null 2>&1 || return 1
  pg_dump --version | sed -n 's/.* \([0-9]\+\).*/\1/p'
}

install_postgres_client() {
  local major
  major="$(pg_client_major || true)"
  if [[ -n "${major:-}" && "$major" -ge 16 ]]; then
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

  apt-get install -y -qq postgresql-client-16
  major="$(pg_client_major || true)"
  [[ -n "${major:-}" && "$major" -ge 16 ]]
}

ensure_pg_client() {
  install_postgres_client && return 0
  if [[ -f /.dockerenv ]]; then
    echo "postgresql-client-16 missing inside orders_app. Run from the Mac host instead:" >&2
    echo "  npm run db:backup" >&2
  elif [[ -n "${CONTAINER:-}" ]]; then
    echo "Run from the Mac host: npm run db:backup" >&2
  else
    echo "Install postgresql-client-16 or start Docker Postgres (docker compose up -d db)" >&2
  fi
  return 1
}
