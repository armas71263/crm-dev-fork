-- Isolation suite — STAFF session (app_role login). Run via tests/run-isolation.sh.
-- Emits label=value lines the runner asserts against expected values.
-- Target-agnostic: identical results on local Docker Postgres and live Supabase.

SELECT set_config('app.tenant_id', 'rubbertrack', false);
SELECT 'A1_rt_records=' || count(*) FROM records;
SELECT 'A2_rt_sees_lexley=' || count(*) FROM records WHERE tenant_id = 'lexley';

-- A3: cross-tenant INSERT must be blocked by RLS WITH CHECK.
DO $$
BEGIN
  INSERT INTO records (tenant_id, order_id, status) VALUES ('lexley', 'HACK-1', 'Open');
  RAISE NOTICE 'A3_FAIL: cross-tenant insert unexpectedly succeeded';
EXCEPTION WHEN with_check_option_violation OR insufficient_privilege OR check_violation THEN
  RAISE NOTICE 'A3_OK: cross-tenant insert blocked by RLS';
END $$;

SELECT set_config('app.tenant_id', 'lexley', false);
SELECT 'B1_lexley_records=' || count(*) FROM records;
SELECT 'B2_lexley_tickets=' || count(*) FROM tickets;

RESET app.tenant_id;
SELECT 'C1_no_tenant_records=' || count(*) FROM records;

-- CRM tables (004/005): same isolation guarantees as the originals.
SELECT set_config('app.tenant_id', 'rubbertrack', false);
SELECT 'CRM1_rt_companies=' || count(*) FROM companies;
SELECT 'CRM2_rt_deals=' || count(*) FROM deals;
SELECT 'CRM3_rt_activities=' || count(*) FROM activities;
SELECT 'CRM4_rt_pipeline=' || count(*) FROM pipeline_stages;
SELECT set_config('app.tenant_id', 'services', false);
SELECT 'CRM5_services_companies=' || count(*) FROM companies;
SELECT 'CRM6_services_deals=' || count(*) FROM deals;
SELECT set_config('app.tenant_id', 'lexley', false);
SELECT 'CRM7_lexley_companies=' || count(*) FROM companies;

-- E: the session helper reflects the session setting.
SELECT set_config('app.tenant_id', 'rubbertrack', false);
SELECT 'E1_current_tenant=' || app.current_tenant();

-- F: screen_configs are tenant-isolated too.
SELECT 'F1_rt_configs=' || count(*) FROM screen_configs WHERE screen = 'dashboard';
SELECT set_config('app.tenant_id', 'lexley', false);
SELECT 'F2_lexley_configs=' || count(*) FROM screen_configs WHERE screen = 'dashboard';
RESET app.tenant_id;
