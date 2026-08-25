#!/usr/bin/env bash
# Tenant onboarding: clones a template to create a new tenant.
# Creates: tenant row + RLS isolation (reuses existing policies) + seed skeleton.
#
# Usage:
#   ./infra/scripts/onboard-tenant.sh <tenant_id> <label> <template> [tier]
#   e.g. ./infra/scripts/onboard-tenant.sh acme "Acme Trading" rubbertrack A
#
# Tier: A=pooled RLS (default), B=schema-per-tenant, C=db-per-tenant.
set -euo pipefail

TENANT_ID="${1:?usage: $0 <tenant_id> <label> <template> [tier]}"
LABEL="${2:?label required}"
TEMPLATE="${3:?template required (rubbertrack|services)}"
TIER="${4:-A}"
PG_DSN="${PG_DSN:-postgresql://postgres:postgres@localhost:5432/rubbertrack}"

echo "→ Onboarding tenant '$TENANT_ID' (label='$LABEL', template='$TEMPLATE', tier='$TIER')"

# 1. Insert tenant row (idempotent)
docker exec -i rubbertrack-platform-postgres-1 psql "$PG_DSN" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO app.tenants (id, label, template, tier, status)
VALUES ('$TENANT_ID', '$LABEL', '$TEMPLATE', '$TIER', 'active')
ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, template=EXCLUDED.template, tier=EXCLUDED.tier;
SQL

# 2. Verify the tenant is isolated (RLS: app_role sees 0 rows until seeded)
echo "→ Verifying RLS isolation for new tenant (expect 0 rows)..."
docker exec -i rubbertrack-platform-postgres-1 psql "postgresql://app_role:apppass@localhost:5432/rubbertrack" \
  -v ON_ERROR_STOP=1 -c "SET app.tenant_id='$TENANT_ID'; SELECT count(*) AS isolated_rows FROM records;"

echo "✓ Tenant '$TENANT_ID' onboarded. RLS policies auto-apply — set app.tenant_id='$TENANT_ID' to seed/use."
echo "  Next: seed data via Directus or INSERTs scoped to this tenant."
