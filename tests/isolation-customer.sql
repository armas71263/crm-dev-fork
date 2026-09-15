-- Isolation suite — CUSTOMER session (app_customer login role, migration 003).
-- Company isolation: restrictive policies AND with the permissive tenant policy
-- (tenant ∩ company), fail-closed when either context is unset.

SELECT set_config('app.tenant_id', 'rubbertrack', false);
SELECT set_config('app.company_id', 'CEAT', false);

SELECT 'D1_ceat_records=' || count(*) FROM records;
SELECT 'D2_ceat_non_own=' || count(*) FROM records WHERE customer <> 'CEAT';
SELECT 'D3_ceat_companies=' || count(*) FROM companies;
SELECT 'D4_ceat_deals=' || count(*) FROM deals;
SELECT 'D5_ceat_contacts=' || count(*) FROM contacts;

-- A customer cannot write, even to their own company's rows.
DO $$
BEGIN
  UPDATE companies SET notes = 'hacked' WHERE name = 'CEAT';
  RAISE NOTICE 'D8_FAIL: customer write unexpectedly succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'D8_OK: customer write denied (SELECT-only role)';
END $$;

RESET app.company_id;
SELECT 'D6_company_unset=' || count(*) FROM deals;

RESET app.tenant_id;
SELECT 'D7_tenant_unset=' || count(*) FROM records;
