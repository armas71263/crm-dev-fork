-- 005: Generic "services" demo tenant — the CRM-core template gets a working
-- dataset so the second template is demonstrable out of the box.

INSERT INTO app.tenants (id, label, template, tier, status) VALUES
  ('services','Generic Services (CRM demo)','services','A','active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO pipeline_stages (tenant_id, key, label, position, probability, stage_type) VALUES
  ('services','new','New',1,10,'open'),
  ('services','qualified','Qualified',2,30,'open'),
  ('services','proposal','Proposal',3,50,'open'),
  ('services','won','Won',4,100,'won'),
  ('services','lost','Lost',5,0,'lost')
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO companies (tenant_id, name, type, industry) VALUES
  ('services','Northwind Traders','customer','Wholesale'),
  ('services','Acme Logistics','prospect','Logistics'),
  ('services','Contoso Supplies','supplier','Distribution')
ON CONFLICT DO NOTHING;

INSERT INTO contacts (tenant_id, company_id, full_name, title, email) VALUES
  ('services', (SELECT id FROM companies WHERE tenant_id='services' AND name='Northwind Traders'), 'Dana White', 'Ops Manager', 'dana@northwind.example'),
  ('services', (SELECT id FROM companies WHERE tenant_id='services' AND name='Acme Logistics'), 'Sam Ortiz', 'CEO', 'sam@acme.example')
ON CONFLICT DO NOTHING;

INSERT INTO leads (tenant_id, name, company_name, contact_name, source, value, status) VALUES
  ('services','Fleet maintenance retainer','Acme Logistics','Sam Ortiz','referral',60000,'qualified'),
  ('services','Warehouse supplies pilot','Northwind Traders','Dana White','cold call',15000,'new')
ON CONFLICT DO NOTHING;

INSERT INTO deals (tenant_id, name, company_id, contact_id, stage, value, currency, expected_close_date, probability, status) VALUES
  ('services','Northwind annual contract',
   (SELECT id FROM companies WHERE tenant_id='services' AND name='Northwind Traders'),
   (SELECT id FROM contacts WHERE tenant_id='services' AND full_name='Dana White'),
   'proposal', 120000, 'USD', '2026-12-01', 50, 'open'),
  ('services','Acme pilot project',
   (SELECT id FROM companies WHERE tenant_id='services' AND name='Acme Logistics'),
   (SELECT id FROM contacts WHERE tenant_id='services' AND full_name='Sam Ortiz'),
   'new', 25000, 'USD', '2026-11-15', 10, 'open')
ON CONFLICT DO NOTHING;

INSERT INTO activities (tenant_id, type, subject, detail, entity, entity_id, due_at, completed) VALUES
  ('services','call','Intro call with Northwind','Covered scope and pricing.',
   'deal', (SELECT id FROM deals WHERE tenant_id='services' AND name='Northwind annual contract'), now() + interval '2 days', false),
  ('services','task','Send pilot proposal to Acme','Two-week trial scope.',
   'deal', (SELECT id FROM deals WHERE tenant_id='services' AND name='Acme pilot project'), now() + interval '1 day', false)
ON CONFLICT DO NOTHING;

INSERT INTO screen_configs (tenant_id, screen, config, active) VALUES
  ('services', 'dashboard', '{
    "panels": [
      {"type":"kpi","source":"open_orders","title":"Open Orders"},
      {"type":"kpi","source":"active_mt","title":"Active MT"},
      {"type":"kpi","source":"suppliers","title":"Suppliers"},
      {"type":"kpi","source":"customers","title":"Customers"},
      {"type":"kpi","source":"open_issues","title":"Open Issues"}
    ]
  }'::jsonb, true)
ON CONFLICT DO NOTHING;
