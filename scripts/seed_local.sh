#!/usr/bin/env bash
# Apply the auth shim + all migrations + the demo-farm seed to a local Postgres
# database for manual inspection. Not for production. No Docker / Supabase CLI needed.
#
# Usage: scripts/seed_local.sh          (env: SEED_DB_NAME, default farmapp_dev)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${SEED_DB_NAME:-farmapp_dev}"

if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then
  runf() { su postgres -c "psql -v ON_ERROR_STOP=1 -X -q -d '$1' -f -"; }
else
  runf() { psql -v ON_ERROR_STOP=1 -X -q -d "$1" -f -; }
fi

echo "==> ensuring local Postgres is up"
pg_isready -q 2>/dev/null || pg_ctlcluster 16 main start 2>/dev/null || true

echo "==> (re)creating '$DB'"
printf "drop database if exists %s with (force);\ncreate database %s;\n" "$DB" "$DB" | runf postgres

echo "==> auth shim"
runf "$DB" < "$ROOT/supabase/tests/shim/auth_shim.sql"

echo "==> migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do runf "$DB" < "$f"; done

echo "==> demo seed"
runf "$DB" < "$ROOT/supabase/seed/demo_farm.sql"

echo "==> seeded local database '$DB'"
