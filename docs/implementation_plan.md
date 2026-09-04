# End-to-End Implementation Plan — Sellable Generic CRM + Analytics + AI Platform

**Status:** Approved architecture, pre-implementation. Supersedes the phased plan in
`build_handbook.md` (Phases 0–5 of the original build are complete; this plan covers the
productization rebuild). All external dependencies license-verified from source as of
2026-09-04. Produced via the grill-me design-tree protocol; every decision recorded below
was explicitly settled with the product owner.

---

## 1. Settled architecture (all rounds of the design tree)

| Layer | Decision |
|---|---|
| Control plane | Directus 12, **vendor-only** (no tenant logins). Tenant-admin features are built as product screens |
| Database | Supabase cloud Postgres (pgvector), managed; free tier while building |
| Auth | Supabase Auth (GoTrue) for all product users. BFF verifies JWTs (ES256/JWKS, iss+aud) and derives tenant/company/role from `app_metadata` claims (service-role key stays server-side only) |
| Tenancy | Pooled RLS tier A retained: `app_role` non-superuser + `set_config('app.tenant_id', …, false)` + `RESET` in `finally`. Session-mode pooler connection (transaction pooler breaks the pattern; direct conn is IPv6-only) |
| CRM | **Generic core**: companies, contacts, leads, deals (configurable pipeline stages), activities, tasks, custom fields via `extra` JSONB. Rubber-trading vertical becomes a template |
| Analytics | Custom KPI engine kept + **WrenAI** embedded (Apache-2.0 core) for GenBI chat-with-data / AI dashboards; per-tenant project + restricted DB role + per-tenant views; 1–2 day isolation spike before commitment |
| AI assistant | Real Vercel AI SDK v5 (`ai@5`) with tool calling; real 768-dim embeddings (nomic-embed-text-v1.5 local, keeps `VECTOR(768)`); RLS-guarded text-to-SQL via a dedicated read-only role; conversation history persisted (semantic memory deferred) |
| Predictions | **Combo A**: AutoGluon (Apache-2.0) — TimeSeries with Chronos-Bolt (Apache-2.0 weights) + AutoARIMA fallback; Tabular with TabPFNMix (Apache-2.0 weights) + LightGBM. TabFM excluded: pretrained weights are non-commercial (`tabfm-non-commercial-v1.0`). TimesFM optional later |
| Frontend | Real Next.js 14 + shadcn/ui + Refine headless app (`apps/web`); `preview/` SPA deleted after parity. No ORM anywhere: raw parameterized SQL behind `tenantQuery` in the BFF; Refine uses a REST data provider against the BFF |
| Monitoring | SigNoz (MIT core, self-hosted) + Uptime Kuma (MIT); **PostHog Cloud free tier** for product analytics (self-hosted needs a dedicated 4vCPU/16GB box — deferred) |
| Billing | Deferred until product works; metering groundwork (`plans` table, caps, `ai_usage_logs` views) built now |
| ORM | **None** (rationale: RLS session state is the security mechanism; ORM abstraction is a liability on that path; small query surface) |

## 2. Known constraints and fixes carried from the code audit

- **G1** Directus must NOT connect as superuser (RLS bypass). On Supabase it gets a dedicated `BYPASSRLS` role; vendor-only usage.
- **G2** `setup-directus.sh` creates permission presets with empty filters (`"permissions": {}`) — rewrite with real tenant filters (`$CURRENT_USER.tenant_id`).
- **G3** Customer company-scoping is unenforced at DB level today (Test D only tested a WHERE clause). New `app_customer` role + company-dimension policies + `SET ROLE` in BFF for customer-role JWTs.
- **G4** No `audit_logs` table exists (docs claimed it) — add tenant-scoped audit written by BFF mutation hook.
- `onboard-tenant.sh` mints predictable passwords (`${TENANT_ID}1234`) — replaced by Supabase invite flow.
- Text-to-SQL must not reuse `app_role` (it holds write grants) — new `app_readonly` role (SELECT only) + `statement_timeout` + row limits.
- Supabase default privileges on `public` tables: as of the 2026-05-30 rollout, new projects do **not** expose new tables to the Data API without explicit grants. Migration checklist still verifies grants once (rollout timing).
- Free tier: projects pause after ~7 days inactivity; 500MB; no PITR — upgrade before real customer data.
- BFF pool: session pooler string (IPv4), `max: 5`.

---

## 3. Phases

### Phase 0 — Baseline (0.5 day)
- Branch from thread branch; update `AGENTS.md` learnings with the new decisions.
- `.env.example`: add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_SESSION_POOLER_URL`, `NEXT_PUBLIC_POSTHOG_KEY`.
- **Verify:** env template documents which keys are server-only.

### Phase 1 — Supabase foundation + real auth (1–1.5 weeks)
1. Project setup checklist: Automatic RLS **on**; verify Data-API exposure default; `CREATE EXTENSION vector` in the project DB; save session-pooler URL + service key.
2. Migration runner: numbered SQL under `infra/migrations/` + `scripts/migrate.sh` (psql + `schema_migrations` table). Apply `helper.sql` + `schema.sql` as migration 001/002. (Init-script-on-fresh-volume constraint no longer applies — everything goes through the runner.)
3. New SQL: `public.profiles` synced from `auth.users` (display name, role); tenant/company/plan live in JWT `app_metadata` as source of truth.
4. DB roles: keep `app_role`; add `app_readonly` (SELECT + statement_timeout) and `app_customer` (company-scoped policies on customer-facing tables: records, files, tickets, deals).
5. BFF (`apps/bff/src/index.js`): `jose` JWKS verification; preHandler: verify → read claims → `set_config` tenant+company GUCs → `SET ROLE app_customer` for customer-role tokens; `RESET ROLE` + `RESET app.tenant_id` in `finally`. **Delete the `x-tenant-id` path.**
6. Directus → Supabase: dedicated `BYPASSRLS` role, vendor-only; rewrite presets with real tenant filters (defense-in-depth even vendor-only).
7. `audit_logs` table + BFF hook on every mutation.
8. Rewrite `tests/isolation.sql`: true customer-role test (`SET ROLE app_customer`), readonly-role test, JWT-path integration script (two test users, cross-tenant attempt must 401/0-rows).
- **Verify:** isolation suite green against Supabase; `curl` without token → 401; plan-limits hook placeholder in place.

### Phase 2 — Generic CRM schema + templates (1 week)
1. Tables: `companies, contacts, leads, deals, activities, tasks` — all tenant_id + RLS + FORCE + indexes; `extra` JSONB custom fields; `pipeline_stages` as per-tenant config.
2. `module-registry.json`: add crm modules; map rubber template (`records` stays as the vertical module; rubber `parties` ↔ `companies`).
3. Extend Excel import/export, screen-config editor, demo-reset to new tables.
4. Seed: generic demo tenant + rubber demo tenant.
- **Verify:** isolation tests extended to new tables; Excel round-trip test; new tenant onboarding script end-to-end.

### Phase 3 — Real Next.js frontend (2–3 weeks)
1. `apps/web`: supabase-js auth (PKCE, middleware), role-based routing.
2. Screens: Dashboard (KPI), CRM modules (companies/contacts/leads/deals/activities/tasks), template modules (records/…), global Search, AI Assistant (SSE), Insights, Screen-config editor, Theme editor (tenant-admin), Users & Invites (tenant-admin), Tenants + usage (vendor).
3. Refine REST data provider against BFF.
4. helmet CSP: add Supabase/PostHog/WrenAI origins; remove `script-src-attr 'unsafe-inline'` once preview SPA dies.
5. Parity checklist vs preview → then delete `preview/` + `@fastify/static`.
- **Verify:** per-screen browser walkthrough (DOM evidence), PostHog events firing, SSE chat works through BFF.

### Phase 4 — AI upgrade + conversation memory (1 week)
1. `apps/ai`: real Vercel AI SDK v5 (`streamText`, tool calling) replacing the hand-rolled planner.
2. Real embeddings: nomic-embed-text-v1.5 (768-d) local (in the Python service or Ollama), NIM key-gated fallback; reindex migration (embeddings table stays `VECTOR(768)`).
3. Text-to-SQL tool: `app_readonly` role + tenant GUC + statement timeout + SELECT-only validation — RLS-guarded by construction.
4. `ai_chat_sessions` / `ai_chat_messages` (RLS) — **conversation memory v1**; semantic memory deferred (embeddings `source_type='memory'` slot reserved).
- **Verify:** grounded answers cite tool observations; SQL tool mutation attempt fails; semantic search sanity check vs old hash embeddings.

### Phase 5 — Predictions service (1 week)
1. New `apps/predictions` FastAPI (Python 3.11): AutoGluon TimeSeries (Chronos-Bolt + AutoARIMA fallback) + Tabular (TabPFNMix + LightGBM); serves embeddings endpoint too.
2. `predictions` table (RLS; model, horizon, generated_at, per-tenant); idempotent scheduled forecast job; cold-start (<N history) → AutoARIMA or explicit "insufficient data".
3. BFF `/data/forecast`; dashboard forecast panel; `get_forecast` assistant tool.
- **Verify:** forecast integration test on seeded history; cold tenant returns insufficient-data; predictions table isolation test.

### Phase 6 — WrenAI embedding (spike 1–2 days, then ~1 week)
1. Spike: per-tenant project + connection profile + restricted DB role scoped to per-tenant views; cross-tenant query attempt **must fail**.
2. On success: compose service, MDL generation from module registry, embed UI in Next.js.
3. Fallback if spike fails: extend the assistant's text-to-SQL into a lightweight dashboard feature (no new dependency).
- **Verify:** spike isolation report; embedded UI walkthrough.

### Phase 7 — Observability (2–3 days)
1. SigNoz compose profile; OTel SDK in BFF/AI/predictions (Node + Python instrumentation).
2. Uptime Kuma for external uptime checks.
3. PostHog Cloud: client events in Next.js, server events in BFF.
- **Verify:** one trace visible end-to-end (BFF→AI→DB); uptime checks green; PostHog dashboard shows real events.

### Phase 8 — Metering groundwork + hardening (2–3 days)
1. `plans` table (modules, seats, AI-token caps) enforced by BFF middleware; usage views over `ai_usage_logs`.
2. Supabase invite flow for users (app_metadata written via service-role from BFF only); delete predictable-password path.
3. Per-tenant logical backup adapted to Supabase + documented restore drill.
4. `DEPLOYMENT.md` refresh; demo-reset for sales.
- **Verify:** cap blocks overuse (test); backup → restore drill passes.

**Total: ~7–10 weeks of focused build.** Dependency order: auth first (everything sits on it), schema second (frontend renders it), frontend third (the product becomes visible), AI/predictions on that base, WrenAI/observability/metering last (independent).

---

## 4. Risk register (carried forward)

| Risk | Handling |
|---|---|
| WrenAI per-tenant isolation unvalidated at scale | Spike precedes commitment; fallback is in-house text-to-SQL dashboards |
| Supabase pooler mode vs session-level `set_config` | Session pooler only; migration checklist asserts it |
| AutoGluon image size (~2–3GB with torch) | Accepted; heaviest container, isolated service |
| PostHog footprint | Cloud free tier during build; self-host decision at production |
| Free-tier pauses / 500MB / no PITR | Unpause via dashboard; upgrade before real customer data |
| Embeddings switch requires reindex | Migration + reindex job in Phase 4 |

## 5. Explicitly out of scope (decided, not forgotten)

- Live email sync (Gmail/IMAP), outreach sequences, telephony — later versions.
- Long-term semantic AI memory — later (schema slot reserved).
- Billing/payments integration — after the product works (metering built now).
- Customer-hosted deployment tier — later (all bundle licenses already chosen to permit it).
- Tier B (schema-per-tenant) / Tier C (db-per-tenant) escalation — retained in code, not exercised.
