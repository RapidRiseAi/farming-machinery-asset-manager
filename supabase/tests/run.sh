#!/usr/bin/env bash
# Apply the Supabase auth shim + all migrations to a fresh local Postgres database,
# then run the RLS isolation suite. Designed to run with zero external dependencies
# (no Docker, no Supabase CLI) — just a local Postgres cluster.
#
# Usage: supabase/tests/run.sh
# Env:   TEST_DB_NAME (default: farmapp_test)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${TEST_DB_NAME:-farmapp_test}"

# Pick how to reach the cluster as a superuser. Prefer `su postgres` (peer auth);
# fall back to a plain psql (e.g. in CI where the current user is a superuser).
if command -v sudo >/dev/null 2>&1 && id postgres >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
  RUNNER="su"
else
  RUNNER="direct"
fi

pg() {           # pg <database> ; reads SQL from stdin
  local db="$1"
  if [ "$RUNNER" = "su" ]; then
    su postgres -c "psql -v ON_ERROR_STOP=1 -X -q -d '$db' -f -"
  else
    psql -v ON_ERROR_STOP=1 -X -q -d "$db" -f -
  fi
}

echo "==> ensuring local Postgres is up"
pg_isready -q 2>/dev/null || pg_ctlcluster 16 main start 2>/dev/null || true

echo "==> (re)creating database '$DB'"
printf "drop database if exists %s with (force);\ncreate database %s;\n" "$DB" "$DB" | pg postgres

echo "==> loading auth shim"
pg "$DB" < "$ROOT/supabase/tests/shim/auth_shim.sql"

echo "==> applying migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "    - $(basename "$f")"
  pg "$DB" < "$f"
done

if [ -f "$ROOT/supabase/tests/rls_isolation.sql" ]; then
  echo "==> running RLS isolation tests"
  pg "$DB" < "$ROOT/supabase/tests/rls_isolation.sql"
fi

echo "==> OK"
