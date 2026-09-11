# RubberTrack Multi-Tenant Platform ā€” Agent Memory

## Project
Sellable multi-tenant CRM + analytics dashboard + CMS. RubberTrack (rubber trading) is the cloneable demo tenant template. See `docs/build_handbook.md` for the full architecture, stack pins, and phased plan.

## Stack (approved)
- Postgres 17 (pgvector image) + RLS pooled tenancy (tier A), escalate to schema-per-tenant (B) / DB-per-tenant (C)
- Directus 12 (control plane: admin UI + REST/GraphQL + auth/RBAC)
- Fastify BFF (v5) ā€” tenant detection, RLS-enforced data endpoints, AI proxy
- Next.js 14 + React + shadcn/ui + Recharts + Refine headless (web app)
- AI: Vercel AI SDK v5 + LlamaIndex.TS; providers OpenRouter / NVIDIA NIM / Ollama / Workers AI

## Key learnings (do not re-discover)
- **RLS does NOT apply to superusers or table owners.** Test/run queries as a non-superuser role (`app_role` in `infra/tenancy/schema.sql`). The `postgres` superuser bypasses all policies.
- **`FORCE ROW LEVEL SECURITY`** makes even the table owner subject to RLS (but superusers still bypass ā€” the app_role is the real guarantee).
- **`SET app.tenant_id = $1` doesn't accept parameters.** Use `SELECT set_config('app.tenant_id', $1, false)` (session-level, `is_local=false`) and `RESET app.tenant_id` in `finally` to avoid pool leak.
- **`set_config(..., true)` is transaction-local** ā€” with pg Pool autocommit, the setting dies before the next query. Always use `is_local=false`.
- `pgvector` extension must be `CREATE EXTENSION` inside the target DB (not just the default `postgres` DB) before any `VECTOR(...)` column.
- Directus image: use `directus/directus:latest` (specific tags like 12.4.1 may not exist).
- Fastify v5 requires `@fastify/cors@^11` and `@fastify/helmet@^13`.
- BFF serves the static `preview/` dir via `@fastify/static` so a single cloudflared tunnel exposes both UI and `/data/*` API.

## Layout resilience (preview)
- KPIs and cards use `grid-template-columns: repeat(auto-fill, minmax(Npx,1fr))` ā€” adding data rows/KPIs never breaks the grid.
- Tables are wrapped in a scrollable `.table-wrap` with sticky headers ā€” any row count works.
- Charts use ECharts with a `ResizeObserver` per chart ā€” they adapt to container/data changes.
- Status colors come from a `STATUS_COLOR` map keyed by status string, not hardcoded indices.
- `loadLiveData()` merges BFF JSON into `DATA`; if the BFF is unreachable, static fallback keeps the UI working.

## Running
- `docker compose up -d` ā†’ postgres:5432, directus:8055, bff:4000, ai:5000, web:3000
- Directus admin: admin@example.com / admin1234
- Preview UI + live data: http://localhost:4000 (BFF serves both)
- Cloudflared quick tunnel: `cloudflared tunnel --url http://localhost:4000` (URL is ephemeral)
- Isolation tests: `docker exec -i <pg> psql "postgresql://app_role:apppass@localhost:5432/rubbertrack" < /tmp/test_isolation.sql`

## Phase status
- Phase 0 (scaffold): DONE ā€” pgvector, helper.sql, app_role
- Phase 1 (template engine): DONE ā€” screen_configs table+RLS, Directus 12 roles/policies (7 roles, idempotent), Excel import/export (date-serial fix), screen-config editor endpoint (GET/PUT), 3 new preview screens (Doc Checker, AI Assistant, Screen Config), isolation Test F pass, Excel round-trip verified.
- Phase 2 (dashboard + hybrid search): DONE ā€” KPI engine (/data/kpi/trend|grades|issues|chart), hybrid /search (tsvector+trgm+optional pgvector), real AI RAG (deterministic 768-dim hash embeddings, /index + /chat, RLS-scoped), global Search screen, dashboard charts wired to live KPI endpoints
- Phase 3 (AI platform): DONE — ai_usage_logs table+RLS, provider router (local/openrouter/nim/openai/ollama w/ key-gated fallback), agentic planner→tools→synthesize (search_records/get_kpi/get_issues/get_party), SSE streaming /chat/stream, insights generator (/insights), Doc Checker field-extraction+mismatch flags, usage dashboard (/ai/usage)
- Phase 4 (ops/escalation): DONE — tenant onboarding + template cloning (BFF /tenants POST), tier escalation A→B schema-per-tenant + B→C db-per-tenant (escalate-tenant.sh + /tenants/:id/escalate), per-tenant logical backup (backup-tenant.sh + /tenants/:id/backup), Tenants admin screen, GitHub Actions CI for isolation tests
- Phase 5 (white-label + release): DONE — per-tenant branding (theme.json in app.tenants.theme, BFF GET/PUT /tenants/:id/theme, preview applies CSS vars live), external customer portal (BFF /portal/overview customer-scoped, preview Portal screen), deployment runbook (DEPLOYMENT.md), demo-reset script

## Repo
Local git only (`/workspace/project`, branch `feat/phase0-1-template-engine`). No remote configured. Commits: ac957ce ā†’ c1e2cb6 ā†’ 187d0ad ā†’ 8843782 ā†’ c24637a (phase0/1 gap closure).

## Key learnings (avoid re-discovering)
- **Directus 12 RBAC** uses policies+access model, NOT legacy `permissions` endpoint directly. Create role ā†’ create policy (links role) ā†’ POST /access (role+policy) ā†’ POST /permissions with `policy` field. Filter hyphenated role names with `limit=-1` list + grep (the `filter[name][_eq]` breaks on hyphens).
- **Excel date parsing**: XLSX serializes dates as serial numbers (e.g. 46235). On import read with `XLSX.read(buf,{type:'buffer',cellDates:true})` + `sheet_to_json(ws,{raw:true,cellDates:true})`, then map `Date` cells to ISO in code (`v instanceof Date ? v.toISOString().slice(0,10) : v ?? null`) — `raw:false`+`dateNF` does NOT normalize real serial cells (they keep the cell's own numFmt, e.g. `8/1/26` or `15-Aug-26`). Pinned by `apps/bff/test/routes.test.js`. Unit tests: `cd apps/bff && npm test` / `cd apps/ai && npm test` (node built-in runner, no extra deps).
- **Postgres init scripts only run on fresh volumes** ā€” to apply schema changes to a running DB, recreate the volume (`docker compose down -v`) or run a migration. The `app_role` is non-superuser so RLS+FORCE applies.
- **RLS pattern**: one `tenant_isolation` policy per table (`FOR ALL USING (tenant_id = app.current_tenant()) WITH CHECK (...)`), ENABLE + FORCE. `app.current_tenant()` reads `current_setting('app.tenant_id')`. Fail-closed when unset (returns NULL ā†’ 0 rows).
- **Preview SPA**: `route()` runs once on load via `loadLiveData().then(route)`; direct-hash navigations rely on `hashchange`. The `render` function can be monkey-patched to hook per-screen init (e.g. load config on the config screen).
- **CSP pitfall**: default helmet CSP sets `script-src-attr 'none'` which silently blocks all inline `onclick=` handlers ā€” buttons look fine but never fire. The BFF now sets an explicit CSP allowing `scriptSrcAttr: 'unsafe-inline'` and `scriptSrc: 'self' + cdn.jsdelivr.net` (for echarts).
- **TDZ pitfall**: calling `loadLiveData()` at the top of app.js threw a silent ReferenceError because it reads `let currentTenant` declared later ā€” the catch fell back to static data so it looked fine. Initial load must run at the END of app.js.
- **Docker-in-docker networking**: start dockerd WITHOUT `--iptables=false` (breaks embedded DNS at 127.0.0.11 ā†’ inter-container name resolution fails with EAI_AGAIN). Build images with `docker build --network=host` to bypass buildkit DNS issues reaching npmjs.

## Productization rebuild (see docs/implementation_plan.md)
- **Auth**: Supabase Auth JWTs (ES256, `jose`, JWKS) verified in the BFF; tenant/company/role come from `app_metadata` (service-role-key-writable only). Production boots fail fast without `SUPABASE_URL`; dev header mode requires explicit `BFF_ALLOW_DEV_AUTH=1`.
- **RLS policy TO-matching follows MEMBERSHIP, not inheritance** (uses `has_privs_of_role`): `GRANT app_customer TO app_role` + `ALTER ROLE app_role NOINHERIT` still applies the customer restrictive policy to every staff session (verified: staff count 7->0 via EXPLAIN's policy filter). Fix: NO memberships - one pg Pool per login role (`app_role` staff, `app_customer` portal, `app_readonly` future text-to-SQL); customer token without customer pool = 503, never staff fallback. Pinned by `apps/bff/test/auth.test.js` + live-DB matrix.
- **Restrictive policies AND with permissive ones**: customer company isolation is `AS RESTRICTIVE FOR SELECT TO app_customer USING (customer = app.current_company())` - tenant INTERSECT company, not OR. Fail-closed when the company GUC is unset.
- **Migrations** go through `infra/scripts/migrate.sh` (numbered SQL + `app.schema_migrations` tracking); init-script-on-fresh-volume semantics no longer apply. 001/002 are the original tenancy files, 003 adds roles/policies/profiles/audit_logs.
- **Supabase**: use the SESSION pooler (transaction pooler breaks session-level `set_config`; direct conn is IPv6-only). Pool `max: 5`. **node-pg needs `ssl:{rejectUnauthorized:false}` for Supabase pooler DSNs** — psql/libpq negotiates TLS automatically, node-pg does not, and a plaintext connection to the pooler hangs forever (no error). Automatic RLS on (safety net; our migrations ENABLE+FORCE explicitly anyway). Custom-role pooler usernames are `role.PROJECT_REF`.
- **Live e2e auth test**: `cd apps/bff && node test/e2e.live.mjs` — boots the BFF against the real Supabase project from `.env`, logs in the three test users (staff.rt/staff.lex/cust.ceat `@test.dev`, created via the Auth Admin API with app_metadata claims), and asserts cross-tenant + company isolation + all 401 fail-closed paths. Not part of `npm test` (needs live env).
- **Unit tests**: `cd apps/bff && npm test` (36) / `cd apps/ai && npm test` (17), node built-in runner.

## Productization progress (Phase 3, 2026-09-08)
- Done + live-verified (ALL PASS via `node apps/web/scripts/verify-session.js` against live Supabase): Dashboard (CRM KPIs + pipeline-by-stage chart), CRM screens + Tasks (activities type=task view), global Search (CRM + vertical legs), AI Assistant (SSE via same-origin Next route-handler proxy `/api/ai/chat/stream`), Insights (+ on-demand regenerate), AI usage, customer Portal. Remaining Phase 3: template module screens, screen-config/theme editors, Users & Invites, vendor Tenants screen, preview parity + deletion.

## Key learnings (productization, addendum)
- **JS `String.replace` treats `$'`, `$&`, `` $` `` in the REPLACEMENT string specially** — replacement text containing e.g. SQL `worth $'||coalesce(...)` silently expands to "everything after the match", duplicating the file tail. For code patching always use `src.split(old).join(new)` or `.replace(old, () => new)` (literal). This bit both hand-rolled patchers and edit tooling.
- **AI is dual-domain**: generic-CRM tools (search_crm / get_crm_kpi / suggest_crm_chart) always run; rubber-vertical tools run only when the tenant's vertical tables hold rows (`hasVerticalData` RLS-scoped probe, 60s cache — no app.tenants grant needed). Chart intents for stage/company/source (or CRM-only tenants) route to `suggest_crm_chart`. Insights: CRM lines for every tenant, vertical lines appended only when vertical data exists.
- **Customer tokens are portal-scoped in the BFF preHandler (JWT mode)**: 403 on everything except `/portal/overview` and GET on the app_customer-granted, RESTRICTIVE-company-policy read routes (`/data/(orders|issues|parties)`, `/data/crm/(companies|contacts|leads|deals|activities)`). The AI proxy must NEVER serve customers — the AI service queries at tenant scope with no company GUC.
- **`/portal/overview` uses the verified token's `companyId` claim** (JWT mode); the `x-customer` header is dev-mode-only.
- **AI service needs the Supabase pooler DSN + TLS** like the BFF (`SUPABASE_DB_SESSION_POOLER_URL`, `ssl: { rejectUnauthorized: false }`) — see `apps/ai/src/index.js`.
- **`./scripts/dev.sh` now supervises the AI service too** (port 5000) alongside BFF (4000) and Next (3000); without it the Assistant/Insights screens are dead endpoints.

## Phase 3 close (2026-09-09)
- `preview/` DELETED — apps/web is the only UI. CSP tightened accordingly (script-src 'self', script-src-attr 'none'; jsdelivr/unsafe-inline gone). Unported legacy demo screens (Doc Tools, Doc Checker) keep their BFF/AI endpoints; port on demand.
```- Attendance (hr_events — mind the reserved-word "leave" column) and Checklists (active checklist_json) screens added; /data/attendance is new, /data/checklists existed.
- Demo users in live Supabase: staff.rt/staff.lex (staff), cust.ceat (customer, company CEAT), vendor@test.dev (vendor — created via admin API; the invite flow only grants staff/customer). All have profiles rows now.
- psql "$SUPABASE_DB_SESSION_POOLER_URL" works from the sandbox; set app.tenant_id per session or RLS hides everything.

## Phase 4 (2026-09-09)
- Text-to-SQL live: `/ai/chat` accepts `sql: SELECT ...`; runs on the `app_readonly` pool (SELECT-only grants, tenant-isolation RLS TO PUBLIC — fail-closed without the GUC, statement timeout). validateSql rejects multi-statement/mutation/forbidden keywords BEFORE the pool. Mutation attempts verified rejected live.
- Conversation memory: migration 007 (ai_chat_sessions/ai_chat_messages, RLS) — the in-process session Map is gone; loadMemory/saveTurn persist turns + tool names + chart intents. Chart refinement survives service restarts (live-verified). Memory errors degrade to no-history, never break chat.
- AI SDK v5 + real embeddings: deferred pending a provider key (OPENROUTER/NIM).

## Phase 4 complete (2026-09-09, Cloudflare Workers AI)
- Provider: `AI_PROVIDER=cloudflare` — qwen3.8-27b via the OpenAI-compatible endpoint (`/accounts/{id}/ai/v1`) routed through the AI Gateway (`cf-aig-gateway-id` header + per-tenant `cf-aig-metadata`); bge-base-en-v1.5 (768-d) embeddings via `/ai/run/{model}` (batch).
- **ai SDK version pairing matters**: `ai@7` + `@ai-sdk/openai-compatible@3` (same spec). Mixing ai@5 with provider@3 fails with "Unsupported model version v4". In ai@7: `maxSteps` is GONE — use `stopWhen: stepCountIs(n)` (default stops at 1 step!); text deltas are `part.text` (not textDelta); usage is `.inputTokens`/`.outputTokens`.
- **qwen3.8-27b is a reasoning model**: emits reasoning-* parts before text; with tools it may burn the whole step budget on retries — the routes synthesize a grounded fallback from tool observations when no final text arrives, so the user never gets silence.
- Latent bug fixed: vertical suggest_chart mapped `type`/`category` dims onto records (no such columns) — now a per-dimension SPECS map (category→tickets) and both chart blocks are guarded (chart failure never 500s chat).
- `.env` gotcha: AI_PROVIDER must exist as a line — an unset var silently means the `local` provider even when all CLOUDFLARE_* keys are present. Restart the whole dev.sh watchdog (it caches .env from ITS start time) after env changes.

## Phase 5 (2026-09-10, predictions)
- apps/predictions: FastAPI in a uv venv (python3.12 — pip needs a venv, PEP 668). dev.sh supervises :5100 with a health check. Connects as app_role via the session pooler with set_config(app.tenant_id) per connection (RLS boundary).
- Forecaster: damped-trend Holt ETS (statsmodels) — deliberately NOT trend-ARIMA: a single outlying month made ARIMA extrapolate ~4x the level. Chronos-Bolt (AutoGluon) is opt-in via PREDICTIONS_USE_CHRONOS=1 (downloaded into the venv but unverified in this environment).
- Migration 008: predictions table (RLS, app_role grants) + synthetic 24-month order history (ORD-HIST-* rows, idempotent) for the demo tenant. The series is a monthly AGGREGATE (~720 MT base).
- Forecast flow: web Generate button -> /api/forecast proxy -> BFF POST /data/forecast -> predictions service (retrain + upsert) -> dashboard reads GET /data/forecast/:series; the assistant reads the stored row via the get_forecast tool (never fabricates).

## Phase 6 (2026-09-11, BI isolation + Ask-the-data)
- BI credentials are ISOLATED BY CONSTRUCTION: schema `bi` views hardcode `WHERE tenant_id = '<tenant>'` (NOT the app.tenant_id GUC — any session can SET that), and `bi_<tenant>` login roles get USAGE on `bi` + SELECT on their own views ONLY. A leaked BI credential cannot read another tenant even with GUC tampering (live-proven). Connect via pooler as `bi_<tenant>.<project_ref>`.
- WrenAI (6 containers) cannot run in the 1.9GB dev sandbox; the dashboard "Ask the data" card is the plan-sanctioned fallback. Production path: per-tenant WrenAI project + connection profile on `bi_<tenant>` credentials, LLM = Cloudflare Workers AI OpenAI-compatible endpoint.
- Long-held NON-STREAMING requests through the Next dev server get killed by the environment (connection severed mid-flight); the SSE streaming proxy is the reliable pattern — the AskDataCard streams via /api/ai/chat/stream.
