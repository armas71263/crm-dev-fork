-- 012: Phase 8 metering — plan catalog, per-tenant plan, rolling usage view.

CREATE TABLE IF NOT EXISTS plans (
  key text PRIMARY KEY,
  name text NOT NULL,
  ai_token_cap_24h int NOT NULL,
  seats int NOT NULL,
  modules jsonb NOT NULL DEFAULT '[]',
  price_usd int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON plans TO app_role;
-- RLS ON with zero policies = deny-all for app_role (bites silently: the cap
-- guard fails OPEN and the summary returns null). The catalog is public
-- product data — a permissive SELECT policy for app_role is correct.
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plans_public_read ON plans;
CREATE POLICY plans_public_read ON plans FOR SELECT TO app_role USING (true);

ALTER TABLE app.tenants ADD COLUMN IF NOT EXISTS plan_key text NOT NULL DEFAULT 'free';

INSERT INTO plans (key, name, ai_token_cap_24h, seats, modules, price_usd) VALUES
  ('free', 'Free', 20000, 3, '[]', 0),
  ('starter', 'Starter', 100000, 10, '["insights","predictions","portal"]', 49),
  ('pro', 'Pro', 400000, 25, '["insights","predictions","portal","suggestions","win_probability"]', 149)
ON CONFLICT (key) DO NOTHING;

-- demo tenant on Pro; the rest stay Free until a vendor upgrades them
UPDATE app.tenants SET plan_key = 'pro' WHERE id = 'rubbertrack';

-- rolling 24h usage per tenant (the metering surface; RLS applies to base rows)
CREATE OR REPLACE VIEW app.tenant_usage_24h AS
SELECT tenant_id,
       coalesce(sum(tokens_in + tokens_out), 0)::int AS tokens_24h,
       count(*)::int AS requests_24h
FROM ai_usage_logs
WHERE created_at > now() - interval '24 hours'
GROUP BY tenant_id;
GRANT SELECT ON app.tenant_usage_24h TO app_role;
-- Views run with OWNER privileges by default (GUC-independent, cross-tenant);
-- security_invoker makes the view honor the CALLER's RLS + GUC.
ALTER VIEW app.tenant_usage_24h SET (security_invoker = true);
