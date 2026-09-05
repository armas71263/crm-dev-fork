#!/usr/bin/env bash
# Numbered SQL migrations for the platform database (Supabase or local Postgres).
# Init-script-on-fresh-volume semantics no longer apply — everything goes through
# this runner so schema changes reach running databases.
#
# Usage: ./infra/scripts/migrate.sh
# DSN resolution: the ADMIN pooler DSN (postgres.<ref>) first — migrations create
# roles and need the table owner; then the session pooler DSN, then PG_* env,
# then the docker-compose defaults.
set -euo pipefail

DSN="${SUPABASE_DB_ADMIN_POOLER_URL:-${SUPABASE_DB_SESSION_POOLER_URL:-postgresql://${PG_ADMIN_USER:-postgres}:${PG_ADMIN_PASSWORD:-postgres}@${PG_HOST:-localhost}:${PG_PORT:-5432}/${PG_DATABASE:-rubbertrack}}}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# id|file — order matters. 001/002 are the original tenancy files, kept in place
# so local dev and Supabase apply the same baseline; add new numbered files below.
MIGRATIONS=(
  "001_helper|infra/tenancy/helper.sql"
  "002_schema|infra/tenancy/schema.sql"
  "003_auth_roles|infra/migrations/003_auth_roles.sql"
)

psql "$DSN" -v ON_ERROR_STOP=1 <<SQL
CREATE SCHEMA IF NOT EXISTS app;
CREATE TABLE IF NOT EXISTS app.schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

for m in "${MIGRATIONS[@]}"; do
  id="${m%%|*}"
  file="${m#*|}"
  applied=$(psql "$DSN" -tAc "SELECT 1 FROM app.schema_migrations WHERE id='${id}'" | tr -d '[:space:]')
  if [ "$applied" = "1" ]; then
    echo "→ ${id} already applied"
    continue
  fi
  echo "→ applying ${id} (${file})"
  psql "$DSN" -v ON_ERROR_STOP=1 -f "$ROOT/$file"
  psql "$DSN" -v ON_ERROR_STOP=1 -c "INSERT INTO app.schema_migrations (id) VALUES ('${id}')"
done

echo "✓ migrations complete"
