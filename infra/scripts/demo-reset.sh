#!/usr/bin/env bash
# Demo reset: wipes the Postgres volume and re-applies ALL migrations via the
# migration runner. The init-mount era is over (compose no longer mounts init
# scripts) — a fresh volume gets the full schema (001..00N) only through
# infra/scripts/migrate.sh, so this reset and production stay identical.
#
# Usage: ./infra/scripts/demo-reset.sh
set -euo pipefail
PG_DSN="${PG_DSN:-postgresql://postgres:postgres@localhost:5432/rubbertrack}"
DOCKER() { docker "$@" 2>/dev/null || sudo docker "$@"; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "→ Resetting demo state (drops + recreates the Postgres volume)..."
DOCKER compose down -v
DOCKER compose up -d --no-deps postgres
echo "→ Waiting for Postgres..."
for i in $(seq 1 40); do DOCKER exec rubbertrack-platform-postgres-1 pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done

echo "→ Applying all migrations (runner, not init scripts)..."
cd "$ROOT" && ./infra/scripts/migrate.sh

echo "→ Verifying seed tenants..."
psql "$PG_DSN" -tAc "SELECT id||' ('||tier||')' FROM app.tenants ORDER BY id;"

echo "→ Reindexing AI knowledge base..."
curl -s -X POST -H "x-tenant-id: rubbertrack" http://localhost:4000/ai/reindex || true
echo

echo "✓ Demo reset complete. Start the rest with: docker compose up -d"
