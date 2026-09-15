-- 003: Auth-era roles, company-level customer scoping, profiles, audit log.
-- Target: Supabase cloud Postgres. Runs on local dev Postgres too (the auth.users
-- FK is guarded). RLS invariant: every new table gets ENABLE + FORCE + a
-- tenant_isolation policy, same as infra/tenancy/schema.sql.

-- ============================================================
-- 1. COMPANY CONTEXT HELPER (NULL when unset → fail-closed)
-- ============================================================
CREATE OR REPLACE FUNCTION app.current_company()
RETURNS TEXT
LANGUAGE SQL
AS $$
  SELECT current_setting('app.company_id', true)
$$;

-- ============================================================
-- 2. app_readonly — SELECT-only role for the AI text-to-SQL tool.
--    The BFF session does SET ROLE app_readonly so generated SQL can never
--    mutate, with a statement timeout as belt-and-braces.
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_readonly') THEN
    CREATE ROLE app_readonly LOGIN PASSWORD 'apppass';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO app_readonly;
GRANT USAGE ON SCHEMA app TO app_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO app_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO app_readonly;
ALTER ROLE app_readonly SET statement_timeout = '10s';

-- ============================================================
-- 3. app_customer — company-scoped read role for portal customers.
--    The BFF does SET ROLE app_customer + set_config('app.company_id', …)
--    for customer-role JWTs. Company isolation is a RESTRICTIVE policy so it
--    ANDs with the existing permissive tenant_isolation policy (tenant ∩ company)
--    instead of being OR-ed around.
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_customer') THEN
    CREATE ROLE app_customer LOGIN PASSWORD 'apppass';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO app_customer;
GRANT USAGE ON SCHEMA app TO app_customer;
GRANT SELECT ON records, tickets, parties TO app_customer;

DROP POLICY IF EXISTS customer_company_isolation ON records;
CREATE POLICY customer_company_isolation ON records
  AS RESTRICTIVE FOR SELECT TO app_customer
  USING (customer = app.current_company());

DROP POLICY IF EXISTS customer_company_isolation ON tickets;
CREATE POLICY customer_company_isolation ON tickets
  AS RESTRICTIVE FOR SELECT TO app_customer
  USING (customer = app.current_company());

DROP POLICY IF EXISTS customer_company_isolation ON parties;
CREATE POLICY customer_company_isolation ON parties
  AS RESTRICTIVE FOR SELECT TO app_customer
  USING (name = app.current_company());

-- NO memberships from app_role to these roles. RLS policy TO-matching uses
-- has_privs_of_role(), which follows role membership REGARDLESS of NOINHERIT
-- (inheritance gates privilege flow, not policy applicability) — granting
-- app_customer TO app_role leaks this restrictive policy into every staff
-- session and nulls out their access. Instead, the BFF connects through a
-- dedicated pool per role (customer requests as the app_customer login role),
-- so current_user itself is the isolation boundary.

-- ============================================================
-- 4. PROFILES — local mirror of auth.users for joins/display.
--    Source of truth for tenant/company/role is the JWT app_metadata
--    (writable only via the service-role key); the BFF upserts this row on
--    first login. FK to auth.users only when the Supabase auth schema exists.
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id          UUID PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES app.tenants(id),
  company_id  TEXT,
  role        TEXT NOT NULL DEFAULT 'staff',
  display_name TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='auth') THEN
    ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_auth_user_fk;
    ALTER TABLE profiles ADD CONSTRAINT profiles_auth_user_fk
      FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_profiles_tenant ON profiles(tenant_id);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON profiles;
CREATE POLICY tenant_isolation ON profiles
  FOR ALL USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON profiles TO app_role;
GRANT SELECT ON profiles TO app_readonly;

-- ============================================================
-- 5. AUDIT LOGS — every BFF mutation, tenant-scoped.
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES app.tenants(id),
  user_id     TEXT,
  action      TEXT NOT NULL,               -- create | update | delete | import | export …
  entity      TEXT,                        -- records | deals | tenants …
  entity_id   TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id, created_at DESC);
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
CREATE POLICY tenant_isolation ON audit_logs
  FOR ALL USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_logs TO app_role;
GRANT SELECT ON audit_logs TO app_readonly;
