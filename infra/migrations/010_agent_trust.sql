-- 010: Phase 6.5 agentic trust layer — evidence ledger, suggestions,
-- durable agent task queue. Mirrors the ai_chat_* RLS pattern from 007.

-- What tools OBSERVED. The rule (skills/evidence.md): nothing about a person
-- or company is guessed — tools report observations; a human settles weak
-- evidence via suggestions. Strong evidence may still only *propose*.
CREATE TABLE IF NOT EXISTS ai_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES app.tenants(id),
  source text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  observation_type text NOT NULL,
  observed jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_obs_tenant_idx ON ai_observations (tenant_id, created_at DESC);

-- Proposed changes pending human settlement. Accept applies a whitelisted
-- field update through the staff pool (RLS); reject just marks it.
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES app.tenants(id),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  field text NOT NULL,
  current_value jsonb,
  proposed_value jsonb NOT NULL,
  evidence text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_suggestions_status CHECK (status IN ('pending','accepted','rejected'))
);
CREATE INDEX IF NOT EXISTS ai_sug_tenant_idx ON ai_suggestions (tenant_id, status, created_at DESC);

-- Durable work queue (FOR UPDATE SKIP LOCKED leases, due_at scheduling).
CREATE TABLE IF NOT EXISTS agent_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES app.tenants(id),
  task_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  due_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_tasks_status CHECK (status IN ('pending','running','done','failed'))
);
CREATE INDEX IF NOT EXISTS agent_tasks_due_idx ON agent_tasks (status, due_at);

DO $fn$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_observations','ai_suggestions','agent_tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($$
      CREATE POLICY tenant_isolation ON %I FOR ALL
        USING (tenant_id = app.current_tenant())
        WITH CHECK (tenant_id = app.current_tenant())$$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
  END LOOP;
END
$fn$;
