# RubberTrack Multi-Tenant Platform — Agent Memory

## Project
Sellable multi-tenant CRM + analytics dashboard + CMS. RubberTrack (rubber trading) is the cloneable demo tenant template. See `docs/build_handbook.md` for the full architecture, stack pins, and phased plan.

## Stack (approved)
- Postgres 17 (pgvector image) + RLS pooled tenancy (tier A), escalate to schema-per-tenant (B) / DB-per-tenant (C)
- Directus 12 (control plane: admin UI + REST/GraphQL + auth/RBAC)
- Fastify BFF (v5) — tenant detection, RLS-enforced data endpoints, AI proxy
- Next.js 14 + React + shadcn/ui + Recharts + Refine headless (web app)
- AI: Vercel AI SDK v5 + LlamaIndex.TS; providers OpenRouter / NVIDIA NIM / Ollama / Workers AI

## Key learnings (do not re-discover)
- **RLS does NOT apply to superusers or table owners.** Test/run queries as a non-superuser role (`app_role` in `infra/tenancy/schema.sql`). The `postgres` superuser bypasses all policies.
- **`FORCE ROW LEVEL SECURITY`** makes even the table owner subject to RLS (but superusers still bypass — the app_role is the real guarantee).
- **`SET app.tenant_id = $1` doesn't accept parameters.** Use `SELECT set_config('app.tenant_id', $1, false)` (session-level, `is_local=false`) and `RESET app.tenant_id` in `finally` to avoid pool leak.
- **`set_config(..., true)` is transaction-local** — with pg Pool autocommit, the setting dies before the next query. Always use `is_local=false`.
- `pgvector` extension must be `CREATE EXTENSION` inside the target DB (not just the default `postgres` DB) before any `VECTOR(...)` column.
- Directus image: use `directus/directus:latest` (specific tags like 12.4.1 may not exist).
- Fastify v5 requires `@fastify/cors@^11` and `@fastify/helmet@^13`.
- BFF serves the static `preview/` dir via `@fastify/static` so a single cloudflared tunnel exposes both UI and `/data/*` API.

## Layout resilience (preview)
- KPIs and cards use `grid-template-columns: repeat(auto-fill, minmax(Npx,1fr))` — adding data rows/KPIs never breaks the grid.
- Tables are wrapped in a scrollable `.table-wrap` with sticky headers — any row count works.
- Charts use ECharts with a `ResizeObserver` per chart — they adapt to container/data changes.
- Status colors come from a `STATUS_COLOR` map keyed by status string, not hardcoded indices.
- `loadLiveData()` merges BFF JSON into `DATA`; if the BFF is unreachable, static fallback keeps the UI working.

## Running
- `docker compose up -d` → postgres:5432, directus:8055, bff:4000, ai:5000, web:3000
- Directus admin: admin@example.com / admin1234
- Preview UI + live data: http://localhost:4000 (BFF serves both)
- Cloudflared quick tunnel: `cloudflared tunnel --url http://localhost:4000` (URL is ephemeral)
- Isolation tests: `docker exec -i <pg> psql "postgresql://app_role:apppass@localhost:5432/rubbertrack" < /tmp/test_isolation.sql`

## Phase status
- Phase 0 (scaffold): DONE — pgvector, helper.sql, app_role
- Phase 1 (template engine): IN PROGRESS — schema + RLS + seed + BFF data endpoints + live preview wiring done; remaining: module registry, screen-config editor, Excel import/export, Directus RBAC mapping, isolation tests D-E (customer scope, staff admin-UI block)
- Phase 2 (dashboard + hybrid search): TODO — KPI engine, chart builder w/ config-in-DB, pgvector+tsvector+trgm hybrid search, global search UI
- Phase 3 (AI platform): TODO
- Phase 4 (ops/escalation): TODO
- Phase 5 (white-label + release): TODO

## Repo
Local git only (`/workspace/project`, branch `master`). No remote configured. Commits: bf93e5c → ac957ce → c1e2cb6 → 187d0ad.
