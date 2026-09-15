-- 007: Conversation memory for the AI assistant (Phase 4).
-- Sessions are keyed per tenant + client session_key; assistant messages keep
-- the tool names and the chart intent+spec so refinements survive restarts.
-- RLS: same tenant_isolation pattern as every other tenant table (TO PUBLIC —
-- app_role writes via the AI service, app_readonly can read if ever needed).

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES app.tenants(id),
  session_key TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, session_key)
);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES app.tenants(id),
  session_id BIGINT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  tools      JSONB NOT NULL DEFAULT '[]',
  chart      JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_chat_messages_session_idx ON ai_chat_messages (session_id, id);

ALTER TABLE ai_chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_chat_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_chat_sessions;
CREATE POLICY tenant_isolation ON ai_chat_sessions
  FOR ALL TO public
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

ALTER TABLE ai_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_chat_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_chat_messages;
CREATE POLICY tenant_isolation ON ai_chat_messages
  FOR ALL TO public
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- The AI service connects as app_role; customers never reach /ai/*.
GRANT SELECT, INSERT, UPDATE ON ai_chat_sessions TO app_role;
GRANT SELECT, INSERT ON ai_chat_messages TO app_role;
