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

# This runner recreates its database. Restrict it to explicit local test targets,
# including when a developer's shell contains connection settings for production.
if [[ ! "$DB" =~ ^[a-z][a-z0-9_]*_test$ ]]; then
  echo "TEST_DB_NAME must be a simple identifier ending in _test." >&2
  exit 1
fi
if [[ -n "${PGSERVICE:-}" || -n "${PGSERVICEFILE:-}" ]]; then
  echo "Unset PostgreSQL service configuration before running local tests." >&2
  exit 1
fi
for host in "${PGHOST:-localhost}" "${PGHOSTADDR:-127.0.0.1}"; do
  case "$host" in
    localhost|127.0.0.1|::1|/var/run/postgresql|/tmp) ;;
    *) echo "Database tests require a local PostgreSQL host." >&2; exit 1 ;;
  esac
done

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

if [ -f "$ROOT/supabase/tests/public_api_and_qr.sql" ]; then
  echo "==> running public API and QR isolation tests"
  pg "$DB" < "$ROOT/supabase/tests/public_api_and_qr.sql"
fi

if [ -f "$ROOT/supabase/tests/post_release_popia.sql" ]; then
  echo "==> running post-release POPIA coverage tests"
  pg "$DB" < "$ROOT/supabase/tests/post_release_popia.sql"
fi

if [ -f "$ROOT/supabase/tests/selected_farm_administration.sql" ]; then
  echo "==> running selected-farm administration tests"
  pg "$DB" < "$ROOT/supabase/tests/selected_farm_administration.sql"
fi

if [ -f "$ROOT/supabase/tests/operator_cost_confidentiality.sql" ]; then
  echo "==> running operator cost-confidentiality tests"
  pg "$DB" < "$ROOT/supabase/tests/operator_cost_confidentiality.sql"
fi

if [ -f "$ROOT/supabase/tests/public_qr_capture.sql" ]; then
  echo "==> running public QR atomic-capture tests"
  pg "$DB" < "$ROOT/supabase/tests/public_qr_capture.sql"
fi

if [ -f "$ROOT/supabase/tests/jobcard_tenant_bindings.sql" ]; then
  echo "==> running job-card tenant-binding tests"
  pg "$DB" < "$ROOT/supabase/tests/jobcard_tenant_bindings.sql"
fi

if [ -f "$ROOT/supabase/tests/billing_subscription.sql" ]; then
  echo "==> running SaaS subscription billing isolation tests"
  pg "$DB" < "$ROOT/supabase/tests/billing_subscription.sql"
fi

echo "==> running atomic offline capture tests"
pg "$DB" < "$ROOT/supabase/tests/atomic_offline_capture.sql"

echo "==> running notification push delivery tests"
pg "$DB" < "$ROOT/supabase/tests/notification_push_delivery.sql"

echo "==> OK"
