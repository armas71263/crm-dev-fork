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
