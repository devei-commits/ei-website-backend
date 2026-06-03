#!/bin/sh
# Install PostgreSQL 16 client tools (pg_restore must match postgres:16 server dump format).
set -eu

if command -v pg_restore >/dev/null 2>&1; then
  if pg_restore --version 2>/dev/null | grep -Eq 'pg_restore \(PostgreSQL\) 16\.'; then
    exit 0
  fi
  echo "[install-pg16-client] Replacing older postgresql-client (dump format mismatch with PG 16 server)."
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "[install-pg16-client] apt-get not available." >&2
  exit 1
fi

DEBIAN_CODENAME="$(. /etc/os-release 2>/dev/null && printf '%s' "${VERSION_CODENAME:-bookworm}")"
DEBIAN_CODENAME="${DEBIAN_CODENAME:-bookworm}"

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates gnupg

install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg

printf '%s\n' \
  "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt ${DEBIAN_CODENAME}-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-client-16

pg_restore --version
