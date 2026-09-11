-- 009: BI isolation primitive (Phase 6 spike).
-- Per-tenant read-only views in schema `bi`, one restricted login role per
-- tenant. The tenant is HARDCODED in each view's WHERE clause — not a session
-- GUC — so a leaked BI credential cannot reach another tenant's rows even by
-- tampering with app.tenant_id. Base tables stay ungranted to the BI roles
-- (fail-closed: direct selects are permission-denied, not filtered).

CREATE SCHEMA IF NOT EXISTS bi;
REVOKE ALL ON SCHEMA bi FROM PUBLIC;

DO $$
DECLARE
  t RECORD;
  tbl TEXT;
  tables TEXT[] := ARRAY['companies','contacts','leads','deals','activities',
                          'records','tickets','parties','feed_items','predictions'];
BEGIN
  FOR t IN SELECT id FROM app.tenants WHERE status = 'active' LOOP
    -- Restricted per-tenant login role. Demo passwords — rotate per deployment.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bi_' || t.id) THEN
      EXECUTE format('CREATE ROLE bi_%s LOGIN PASSWORD %L', t.id, t.id || '-bi-demo-pass');
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA bi TO bi_%s', t.id);
    FOREACH tbl IN ARRAY tables LOOP
      EXECUTE format(
        'CREATE OR REPLACE VIEW bi.%s_%s AS SELECT * FROM public.%s WHERE tenant_id = %L',
        t.id, tbl, tbl, t.id);
      EXECUTE format('GRANT SELECT ON bi.%s_%s TO bi_%s', t.id, tbl, t.id);
    END LOOP;
  END LOOP;
END $$;
