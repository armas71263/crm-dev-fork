-- 011: Phase 6.7 — governed metrics registry + dashboard widgets;
-- Phase 5 completion — deal_history training corpus + insights commentary.

-- Certified metric definitions: each metric defined ONCE; the assistant,
-- dashboards and KPI cards all execute the same SQL via the staff pool (RLS).
CREATE TABLE IF NOT EXISTS metric_definitions (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES app.tenants(id),
  key text NOT NULL,
  label text NOT NULL,
  description text NOT NULL,
  unit text NOT NULL DEFAULT '',
  sql text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  CONSTRAINT metric_status CHECK (status IN ('draft','certified'))
);

-- Per-user pinned dashboard widgets. The spec stores the QUERY (metric key
-- or dimension aggregation), never rendered data — widgets stay live.
CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES app.tenants(id),
  user_id uuid,
  position int NOT NULL DEFAULT 0,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Phase 5 completion: historical deal corpus for the win-probability model.
-- Synthetic but with baked-in signal (see AGENTS.md); NOT exposed in CRM UIs.
CREATE TABLE IF NOT EXISTS deal_history (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES app.tenants(id),
  value numeric(12,2) NOT NULL,
  stage text NOT NULL,
  company_type text,
  source text,
  days_open int NOT NULL,
  activities_count int NOT NULL,
  won boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DROP POLICY IF EXISTS tenant_isolation ON metric_definitions;
ALTER TABLE metric_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metric_definitions FOR ALL
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON metric_definitions TO app_role;

DROP POLICY IF EXISTS tenant_isolation ON dashboard_widgets;
ALTER TABLE dashboard_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_widgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dashboard_widgets FOR ALL
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON dashboard_widgets TO app_role;

DROP POLICY IF EXISTS tenant_isolation ON deal_history;
ALTER TABLE deal_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deal_history FOR ALL
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON deal_history TO app_role;


-- Seed certified metrics for every active tenant (idempotent).
DO $seed$
DECLARE t RECORD;
BEGIN
  FOR t IN SELECT id FROM app.tenants WHERE status = 'active' LOOP
    INSERT INTO metric_definitions (tenant_id, key, label, description, unit, sql, status) VALUES
      (t.id, 'companies_count', 'Active companies', 'Count of company records.', '', 'SELECT count(*)::int AS value FROM companies', 'certified'),
      (t.id, 'contacts_count', 'Contacts', 'Count of contact records.', '', 'SELECT count(*)::int AS value FROM contacts', 'certified'),
      (t.id, 'open_leads_count', 'Open leads', 'Leads not yet closed (won/lost/converted/disqualified excluded).', '', 'SELECT count(*)::int AS value FROM leads WHERE status NOT IN (''won'',''lost'',''converted'',''disqualified'',''closed'')', 'certified'),
      (t.id, 'open_deals_count', 'Open deals', 'Deals with status open.', '', 'SELECT count(*)::int AS value FROM deals WHERE status=''open''', 'certified'),
      (t.id, 'pipeline_value', 'Pipeline value', 'Total value of open deals. The certified definition — every surface uses this number.', 'USD', 'SELECT coalesce(sum(value),0)::float AS value FROM deals WHERE status=''open''', 'certified'),
      (t.id, 'open_tasks_count', 'Open tasks', 'Incomplete task activities.', '', 'SELECT count(*)::int AS value FROM activities WHERE type=''task'' AND NOT completed', 'certified'),
      (t.id, 'overdue_tasks_count', 'Overdue tasks', 'Open tasks past their due date.', '', 'SELECT count(*)::int AS value FROM activities WHERE type=''task'' AND NOT completed AND due_at < now()', 'certified'),
      (t.id, 'order_volume_mt', 'Total order volume', 'Sum of order records volume (vertical).', 'MT', 'SELECT coalesce(sum(mt),0)::float AS value FROM records', 'certified'),
      (t.id, 'revenue_total', 'Total revenue', 'Volume x price across order records (vertical).', 'USD', 'SELECT coalesce(sum(mt*price_usd),0)::float AS value FROM records', 'certified'),
      (t.id, 'open_issues_count', 'Open issues', 'Tickets not yet resolved (vertical).', '', 'SELECT count(*)::int AS value FROM tickets WHERE status<>''Resolved''', 'certified')
    ON CONFLICT (tenant_id, key) DO NOTHING;
  END LOOP;
END
$seed$;

-- Idempotent synthetic training corpus with real logistic signal:
-- more activities / later stage / customer-type / referral -> higher P(won);
-- bigger deals and longer open time -> lower. setseed makes it reproducible.
INSERT INTO deal_history (tenant_id, value, stage, company_type, source, days_open, activities_count, won)
WITH seeded AS (SELECT setseed(0.4231))
SELECT 'rubbertrack', value, stage, company_type, source, days_open, activities_count, won FROM (
  WITH base AS (
    SELECT
      round((5000 + (random() * 195000))::numeric, 2) AS value,
      (5 + random() * 175)::int AS days_open,
      (1 + random() * 29)::int AS activities_count,
      (ARRAY['qualification','proposal','negotiation'])[1 + (g % 3)] AS stage,
      (ARRAY['customer','prospect','partner'])[1 + (g % 3)] AS company_type,
      (ARRAY['referral','outbound','inbound'])[1 + (g % 3)] AS source
    FROM generate_series(1, 150) g, seeded
  ), feats AS (
    SELECT b.*,
      CASE stage WHEN 'qualification' THEN 0.0 WHEN 'proposal' THEN 0.7 WHEN 'negotiation' THEN 1.3 END AS stage_w,
      CASE company_type WHEN 'prospect' THEN 0.1 WHEN 'customer' THEN 0.8 WHEN 'partner' THEN 0.5 END AS ctype_w,
      CASE source WHEN 'inbound' THEN 0.2 WHEN 'referral' THEN 0.7 WHEN 'outbound' THEN 0.0 END AS source_w
    FROM base b
  )
  SELECT value, stage, company_type, source, days_open, activities_count,
    random() < 1.0 / (1.0 + exp(-(
      0.9 * activities_count / 10.0
      - 0.7 * days_open / 60.0
      - 0.8 * value / 100000.0
      + stage_w + 0.4 * ctype_w + 0.5 * source_w
    ))) AS won
  FROM feats
) f
WHERE NOT EXISTS (SELECT 1 FROM deal_history WHERE tenant_id = 'rubbertrack');

-- Insights snapshots gain an optional AI commentary column (deterministic
-- computed lines stay the source of truth; commentary only cites them).
ALTER TABLE insights_snapshots ADD COLUMN IF NOT EXISTS commentary text;
