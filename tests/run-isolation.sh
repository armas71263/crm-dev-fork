#!/usr/bin/env bash
# Isolation suite runner — three sessions, one per login role (no SET ROLE:
# see migration 003 for why role membership is forbidden).
#   app_role     → tests/isolation.sql          (staff + CRM tables)
#   app_customer → tests/isolation-customer.sql (company scoping, fail-closed)
#   app_readonly → write-denial probe
# DSNs: Supabase pooler URLs from the environment (if .env is sourced) or local
# docker defaults. Identical expectations on both targets.
set -euo pipefail
cd "$(dirname "$0")/.."

STAFF_DSN="${SUPABASE_DB_SESSION_POOLER_URL:-postgresql://app_role:apppass@localhost:5432/rubbertrack}"
CUSTOMER_DSN="${SUPABASE_DB_CUSTOMER_POOLER_URL:-postgresql://app_customer:apppass@localhost:5432/rubbertrack}"
READONLY_DSN="${SUPABASE_DB_READONLY_POOLER_URL:-postgresql://app_readonly:apppass@localhost:5432/rubbertrack}"

fail=0
check() { # expected-line
  if echo "$OUT" | grep -qxF "$1"; then echo "✓ $1"; else echo "❌ expected $1 — got:"; echo "$OUT" | grep "^${1%%=}" || echo "  (missing)"; fail=1; fi
}

echo "== Staff session (app_role) =="
OUT=$(psql "$STAFF_DSN" -tA -v ON_ERROR_STOP=1 -f tests/isolation.sql 2>&1) || { echo "$OUT"; exit 1; }
echo "$OUT" | grep -q 'A3_OK' && echo '✓ A3 cross-tenant INSERT blocked' || { echo '❌ A3 not blocked'; fail=1; }
check 'A1_rt_records=7'
check 'A2_rt_sees_lexley=0'
check 'B1_lexley_records=1'
check 'B2_lexley_tickets=0'
check 'C1_no_tenant_records=0'
check 'CRM1_rt_companies=3'
check 'CRM2_rt_deals=3'
check 'CRM3_rt_activities=3'
check 'CRM4_rt_pipeline=6'
check 'CRM5_services_companies=3'
check 'CRM6_services_deals=2'
check 'CRM7_lexley_companies=0'
check 'E1_current_tenant=rubbertrack'
check 'F1_rt_configs=1'
check 'F2_lexley_configs=0'

echo "== Customer session (app_customer) =="
OUT=$(psql "$CUSTOMER_DSN" -tA -v ON_ERROR_STOP=1 -f tests/isolation-customer.sql 2>&1) || { echo "$OUT"; exit 1; }
echo "$OUT" | grep -q 'D8_OK' && echo '✓ D8 customer write denied' || { echo '❌ D8 customer write not denied'; fail=1; }
check 'D1_ceat_records=1'
check 'D2_ceat_non_own=0'
check 'D3_ceat_companies=1'
check 'D4_ceat_deals=2'
check 'D5_ceat_contacts=1'
check 'D6_company_unset=0'
check 'D7_tenant_unset=0'

echo "== Read-only session (app_readonly) =="
RO_OUT=$(psql "$READONLY_DSN" -tA -v ON_ERROR_STOP=1 -c \
  "SELECT set_config('app.tenant_id','rubbertrack',false); INSERT INTO records (tenant_id, order_id, status) VALUES ('rubbertrack','HACK-1','Open');" 2>&1) \
  && { echo "❌ readonly INSERT unexpectedly succeeded"; fail=1; } \
  || echo "$RO_OUT" | grep -q 'permission denied' && echo '✓ readonly INSERT denied' || { echo '❌ readonly denial not the expected error'; fail=1; }

if [ "$fail" -ne 0 ]; then echo; echo "❌ Isolation suite FAILED"; exit 1; fi
echo; echo "✅ Isolation suite passed (staff, customer, readonly)."
