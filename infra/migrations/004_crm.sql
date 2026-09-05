-- 004: Generic CRM core — companies, contacts, leads, deals, activities
-- (tasks and notes are activity types, not separate tables: same behavior,
-- one schema), per-tenant pipeline stages, custom fields via `extra` JSONB.
-- RLS invariant identical to schema.sql: tenant_id + ENABLE + FORCE +
-- tenant_isolation policy on every table; customer restrictive policies AND
-- with the permissive tenant policy (tenant ∩ company).

-- ============================================================
-- 1. PIPELINE STAGES (per-tenant deal stages; drives the deals UI)
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES app.tenants(id),
  key         TEXT NOT NULL,
  label       TEXT NOT NULL,
  position    INT NOT NULL DEFAULT 0,
  probability INT NOT NULL DEFAULT 0,            -- 0-100 default win probability
  stage_type  TEXT NOT NULL DEFAULT 'open',      -- open | won | lost
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_tenant ON pipeline_stages(tenant_id, position);
ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pipeline_stages;
CREATE POLICY tenant_isolation ON pipeline_stages
  FOR ALL USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_stages TO app_role;
GRANT SELECT ON pipeline_stages TO app_readonly;

-- ============================================================
-- 2. COMPANIES
-- ============================================================
CREATE TABLE IF NOT EXISTS companies (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES app.tenants(id),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'customer',  -- customer | prospect | supplier | partner
  industry    TEXT,
  website     TEXT,
  phone       TEXT,
  email       TEXT,
  address     TEXT,
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  owner_id    TEXT,
  extra       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_companies_tenant ON companies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(tenant_id, name);
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON companies;
CREATE POLICY tenant_isolation ON companies
  FOR ALL USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
DROP POLICY IF EXISTS customer_company_isolation ON companies;
CREATE POLICY customer_company_isolation ON companies
  AS RESTRICTIVE FOR SELECT TO app_customer
  USING (name = app.current_company());
GRANT SELECT ON companies TO app_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON companies TO app_role;
GRANT SELECT ON companies TO app_readonly;

-- ============================================================
-- 3. CONTACTS
-- ============================================================
CREATE TABLE IF NOT EXISTS contacts (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES app.tenants(id),
  company_id  BIGINT REFERENCES companies(id),
  full_name   TEXT NOT NULL,
  first_name  TEXT,
  last_name   TEXT,
  title       TEXT,
  email       TEXT,
  phone       TEXT,
  mobile      TEXT,
  linkedin    TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  owner_id    TEXT,
  extra       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(tenant_id, company_id);
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON contacts;
CREATE POLICY tenant_isolation ON contacts
  FOR ALL USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
DROP POLICY IF EXISTS customer_company_isolation ON contacts;
CREATE POLICY customer_company_isolation ON contacts
  AS RESTRICTIVE FOR SELECT TO app_customer
  USING (company_id IS NULL OR EXISTS (
    SELECT 1 FROM companies c WHERE c.id = contacts.company_id AND c.name = app.current_company()
  ));
GRANT SELECT ON contacts TO app_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_role;
GRANT SELECT ON contacts TO app_readonly;

-- ============================================================
-- 4. LEADS
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES app.tenants(id),
  name        TEXT NOT NULL,
  company_name TEXT,
  contact_name TEXT,
  email       TEXT,
  phone       TEXT,
  source      TEXT,
  value       NUMERIC(12,2),
  status      TEXT NOT NULL DEFAULT 'new',       -- new | working | qualified | unqualified | converted
  owner_id    TEXT,
  extra       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id);
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON leads;
CREATE POLICY tenant_isolation ON leads
  FOR ALL USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON leads TO app_role;
GRANT SELECT ON leads TO app_readonly;

-- ============================================================
-- 5. DEALS
-- ============================================================
CREATE TABLE IF NOT EXISTS deals (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES app.tenants(id),
  name        TEXT NOT NULL,
  company_id  BIGINT REFERENCES companies(id),
  contact_id  BIGINT REFERENCES contacts(id),
  lead_id     BIGINT REFERENCES leads(id),
  stage       TEXT NOT NULL,
  value       NUMERIC(12,2),
  currency    TEXT NOT NULL DEFAULT 'USD',
  expected_close_date DATE,
  probability INT,
  status      TEXT NOT NULL DEFAULT 'open',      -- open | won | lost
  owner_id    TEXT,
  extra       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deals_tenant ON deals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(tenant_id, stage);
CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(tenant_id, company_id);
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON deals;
CREATE POLICY tenant_isolation ON deals
  FOR ALL USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
DROP POLICY IF EXISTS customer_company_isolation ON deals;
CREATE POLICY customer_company_isolation ON deals
  AS RESTRICTIVE FOR SELECT TO app_customer
  USING (EXISTS (
    SELECT 1 FROM companies c WHERE c.id = deals.company_id AND c.name = app.current_company()
  ));
GRANT SELECT ON deals TO app_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON deals TO app_role;
GRANT SELECT ON deals TO app_readonly;

-- ============================================================
-- 6. ACTIVITIES (calls, meetings, tasks, notes — type column)
-- ============================================================
CREATE TABLE IF NOT EXISTS activities (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES app.tenants(id),
  type        TEXT NOT NULL DEFAULT 'note',      -- call | email | meeting | task | note
  subject     TEXT NOT NULL,
  detail      TEXT,
  entity      TEXT,                              -- company | contact | lead | deal
  entity_id   BIGINT,
  due_at      TIMESTAMPTZ,
  completed   BOOLEAN NOT NULL DEFAULT false,
  user_id     TEXT,
  extra       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activities_tenant ON activities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities(tenant_id, entity, entity_id);
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON activities;
CREATE POLICY tenant_isolation ON activities
  FOR ALL USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
DROP POLICY IF EXISTS customer_company_isolation ON activities;
CREATE POLICY customer_company_isolation ON activities
  AS RESTRICTIVE FOR SELECT TO app_customer
  USING (entity IS DISTINCT FROM 'deal' OR EXISTS (
    SELECT 1 FROM companies c
    JOIN deals d ON d.company_id = c.id
    WHERE d.id = activities.entity_id AND c.name = app.current_company()
  ));
GRANT SELECT ON activities TO app_customer;
GRANT SELECT, INSERT, UPDATE, DELETE ON activities TO app_role;
GRANT SELECT ON activities TO app_readonly;

-- ============================================================
-- 7. DEFAULT PIPELINE + CRM DEMO SEED (rubbertrack demo tenant)
-- ============================================================
INSERT INTO pipeline_stages (tenant_id, key, label, position, probability, stage_type) VALUES
  ('rubbertrack','new','New',1,10,'open'),
  ('rubbertrack','qualified','Qualified',2,30,'open'),
  ('rubbertrack','proposal','Proposal',3,50,'open'),
  ('rubbertrack','negotiation','Negotiation',4,70,'open'),
  ('rubbertrack','won','Won',5,100,'won'),
  ('rubbertrack','lost','Lost',6,0,'lost')
ON CONFLICT (tenant_id, key) DO NOTHING;

-- Seed a handful of CRM rows for the demo tenant (rubbertrack).
INSERT INTO companies (tenant_id, name, type, industry) VALUES
  ('rubbertrack','CEAT','customer','Tire manufacturing'),
  ('rubbertrack','BKT','customer','Tire manufacturing'),
  ('rubbertrack','Lexley Rubber','supplier','Rubber trading')
ON CONFLICT DO NOTHING;

INSERT INTO contacts (tenant_id, company_id, full_name, title, email, phone) VALUES
  ('rubbertrack', (SELECT id FROM companies WHERE tenant_id='rubbertrack' AND name='CEAT'), 'Priya Sharma', 'Procurement Lead', 'priya@ceat.example', '+91-22-555-0101'),
  ('rubbertrack', (SELECT id FROM companies WHERE tenant_id='rubbertrack' AND name='BKT'), 'Raj Mehta', 'Head of Sourcing', 'raj@bkt.example', '+91-22-555-0102')
ON CONFLICT DO NOTHING;

INSERT INTO leads (tenant_id, name, company_name, contact_name, source, value, status) VALUES
  ('rubbertrack','TSR-20 supply to MRF','MRF','Anil Kumar','referral',125000,'qualified'),
  ('rubbertrack','Latex grade pilot','Apollo Tyres','Sunita Rao','website',40000,'new')
ON CONFLICT DO NOTHING;

INSERT INTO deals (tenant_id, name, company_id, contact_id, stage, value, currency, expected_close_date, probability, status) VALUES
  ('rubbertrack','CEAT Q4 TSR-20 contract',
   (SELECT id FROM companies WHERE tenant_id='rubbertrack' AND name='CEAT'),
   (SELECT id FROM contacts WHERE tenant_id='rubbertrack' AND full_name='Priya Sharma'),
   'negotiation', 250000, 'USD', '2026-11-30', 70, 'open'),
  ('rubbertrack','BKT annual RSS3 supply',
   (SELECT id FROM companies WHERE tenant_id='rubbertrack' AND name='BKT'),
   (SELECT id FROM contacts WHERE tenant_id='rubbertrack' AND full_name='Raj Mehta'),
   'proposal', 180000, 'USD', '2026-12-15', 50, 'open'),
  ('rubbertrack','CEAT pilot shipment',
   (SELECT id FROM companies WHERE tenant_id='rubbertrack' AND name='CEAT'),
   (SELECT id FROM contacts WHERE tenant_id='rubbertrack' AND full_name='Priya Sharma'),
   'won', 45000, 'USD', '2026-08-31', 100, 'won')
ON CONFLICT DO NOTHING;

INSERT INTO activities (tenant_id, type, subject, detail, entity, entity_id, due_at, completed) VALUES
  ('rubbertrack','call','Follow up on TSR-20 pricing','Discussed DAP terms; awaiting confirmation.',
   'deal', (SELECT id FROM deals WHERE tenant_id='rubbertrack' AND name='CEAT Q4 TSR-20 contract'), now() + interval '3 days', false),
  ('rubbertrack','task','Send updated spec sheet','Include FFA % and HS codes.',
   'deal', (SELECT id FROM deals WHERE tenant_id='rubbertrack' AND name='BKT annual RSS3 supply'), now() + interval '1 day', false),
  ('rubbertrack','note','Pilot shipment delivered','Closed positively; reference for future contracts.',
   'deal', (SELECT id FROM deals WHERE tenant_id='rubbertrack' AND name='CEAT pilot shipment'), null, true)
ON CONFLICT DO NOTHING;
