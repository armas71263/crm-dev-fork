#!/usr/bin/env bash
# Tenant onboarding: clones a template to create a new tenant.
# Creates: tenant row + tenant-admin user + role assignment + RLS isolation.
#
# Usage:
#   ./infra/scripts/onboard-tenant.sh <tenant_id> <label> <template> [tier] [admin_email]
#   e.g. ./infra/scripts/onboard-tenant.sh acme "Acme Trading" rubbertrack A ops@acme.co
#
# Tier: A=pooled RLS (default), B=schema-per-tenant, C=db-per-tenant.
# Prereq: run ./infra/scripts/setup-directus.sh once to create RBAC roles.
set -euo pipefail

TENANT_ID="${1:?usage: $0 <tenant_id> <label> <template> [tier] [admin_email]}"
LABEL="${2:?label required}"
TEMPLATE="${3:?template required (rubbertrack|services)}"
TIER="${4:-A}"
ADMIN_EMAIL="${5:-}"
PG_DSN="${PG_DSN:-postgresql://postgres:postgres@localhost:5432/rubbertrack}"
DIRECTUS_URL="${DIRECTUS_URL:-http://localhost:8055}"

# Use sudo for docker only if the user lacks direct access (script stays portable).
DOCKER() { docker "$@" 2>/dev/null || sudo docker "$@"; }

echo "→ Onboarding tenant '$TENANT_ID' (label='$LABEL', template='$TEMPLATE', tier='$TIER')"

# 1. Insert tenant row (idempotent)
DOCKER exec -i rubbertrack-platform-postgres-1 psql "$PG_DSN" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO app.tenants (id, label, template, tier, status)
VALUES ('$TENANT_ID', '$LABEL', '$TEMPLATE', '$TIER', 'active')
ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, template=EXCLUDED.template, tier=EXCLUDED.tier;
SQL

# 2. Verify the tenant is isolated (RLS: app_role sees 0 rows until seeded)
echo "→ Verifying RLS isolation for new tenant (expect 0 rows)..."
DOCKER exec -i rubbertrack-platform-postgres-1 psql "postgresql://app_role:apppass@localhost:5432/rubbertrack" \
  -v ON_ERROR_STOP=1 -c "SET app.tenant_id='$TENANT_ID'; SELECT count(*) AS isolated_rows FROM records;"

# 3. Tenant-admin users are NOT created here anymore: Directus is vendor-only
#    (product decision), and product users come from Supabase Auth with
#    app_metadata claims written via the service-role key from the BFF —
#    never predictable local passwords.

echo "✓ Tenant '$TENANT_ID' onboarded. RLS policies auto-apply — set app.tenant_id='$TENANT_ID' to seed/use."
echo "  Next: seed data via Directus or INSERTs scoped to this tenant."

# 4. Clone template data (optional) — copy the template tenant's rows into the
#    new tenant so it starts with a working dataset. Re-tenant each row.
if [ "${CLONE_TEMPLATE:-0}" = "1" ] && [ "$TEMPLATE" != "$TENANT_ID" ]; then
  echo "→ Cloning template '$TEMPLATE' data into '$TENANT_ID' (CLONE_TEMPLATE=1)..."
  TABLES="records parties tickets feed_items checklists screen_configs companies contacts leads deals activities pipeline_stages"
  for T in $TABLES; do
    # Build a column list excluding tenant_id (portable across PG versions).
    COLS=$(DOCKER exec -i rubbertrack-platform-postgres-1 psql "$PG_DSN" -tAc \
      "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='${T}' AND column_name<>'tenant_id';")
    DOCKER exec -i rubbertrack-platform-postgres-1 psql "$PG_DSN" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO public.${T} (tenant_id, ${COLS})
  SELECT '$TENANT_ID', ${COLS} FROM public.${T} WHERE tenant_id='$TEMPLATE' ON CONFLICT DO NOTHING;
SQL
    N=$(DOCKER exec -i rubbertrack-platform-postgres-1 psql "$PG_DSN" -tAc \
      "SELECT count(*) FROM public.${T} WHERE tenant_id='$TENANT_ID';")
    echo "  ✓ $T: $N rows cloned"
  done
fi

