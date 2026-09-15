-- 006: Directus control-plane role on the shared database.
-- Why a dedicated role: on Supabase the `postgres.<ref>` role is NOT a superuser
-- and every app table has FORCE RLS, so Directus connecting as postgres would
-- see ZERO rows (the tenant GUC is never set in Directus connections). Instead
-- a dedicated directus_admin login role gets explicit permissive policies —
-- vendor access is deliberate and self-documenting, never an accidental
-- superuser bypass. No memberships in either direction (see 003: policy
-- TO-matching follows membership).
-- NOTE: directus_* system tables are created by Directus itself in public.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='directus_admin') THEN
    -- Dev default; migrate.sh callers should ALTER to a strong password
    -- (same pattern as app_role in 003).
    CREATE ROLE directus_admin LOGIN PASSWORD 'directusdev';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO directus_admin;
GRANT USAGE ON SCHEMA app TO directus_admin;
GRANT CREATE ON SCHEMA public TO directus_admin;  -- for directus_* system tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO directus_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO directus_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO directus_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO directus_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO directus_admin;

-- Explicit vendor-bypass policy on every tenant table: permissive, OR-ed with
-- the tenant policy, so directus_admin sees and edits all tenants. This is the
-- ONLY role besides the superuser with cross-tenant access, and it exists
-- solely for the vendor control plane.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'records','parties','tickets','hr_events','feed_items','checklists','files',
    'embeddings','screen_configs','ai_usage_logs','insights_snapshots',
    'companies','contacts','leads','deals','activities','pipeline_stages',
    'profiles','audit_logs'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS directus_admin_bypass ON %I', t);
    EXECUTE format(
      'CREATE POLICY directus_admin_bypass ON %I FOR ALL TO directus_admin USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
