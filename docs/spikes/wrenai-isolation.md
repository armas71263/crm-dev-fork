# Phase 6 spike: per-tenant BI isolation (2026-09-11)

## Question
Can a GenBI engine (WrenAI) be pointed at a fixed per-tenant database
credential such that a leaked or tampered connection can NEVER read another
tenant's rows?

## Design (migration 009)
- Schema `bi` with one view per tenant per data table
  (`bi.rubbertrack_companies`, ...): the tenant id is HARDCODED in the view's
  WHERE clause — deliberately NOT the `app.tenant_id` GUC.
- One restricted login role per active tenant (`bi_rubbertrack`, ...): granted
  USAGE on `bi` + SELECT on ITS OWN views only. No grants on public tables.

Why hardcoded views rather than GUC-scoped RLS: any session can `SET
app.tenant_id = <other-tenant>`, which would silently redirect GUC-keyed RLS.
The view definition is evaluated server-side against the view owner, so the
tenant filter cannot be influenced by the connecting session at all.

## Live verification (Supabase session pooler, role bi_rubbertrack)

| # | Attempt | Result |
|---|---------|--------|
| 1 | `SELECT count(*) FROM bi.rubbertrack_companies` | 3 (rubbertrack's rows) |
| 2 | `SELECT count(*) FROM public.companies` | `permission denied for table companies` |
| 3 | `SELECT count(*) FROM bi.lexley_companies` | `permission denied for view lexley_companies` |
| 4 | `SET app.tenant_id='lexley'; SELECT ... bi.rubbertrack_companies` | still 3 — own rows only (GUC tamper-proof) |
| 5 | Same SET + `bi.lexley_records` | `permission denied` |

Ground truth: companies per tenant = rubbertrack 3, services 3, lexley 0.

**Result: PASS.** A WrenAI connection profile using `bi_<tenant>` credentials
is isolated by construction, even under credential compromise.

## WrenAI runtime feasibility (this dev sandbox)
- WrenAI's stack is 6 containers (bootstrap, wren-engine, ibis-server,
  wren-ai-service, qdrant, wren-ui). The sandbox has 1.9GB RAM total with our
  4 dev services already resident — empirically infeasible here (memory guard
  kills far smaller processes), and its UI binds :3000 (conflicts with apps/web).
- Per the implementation plan, the fallback applies: the assistant's
  text-to-SQL is exposed as a lightweight dashboard feature ("Ask the data").
- Production path (documented, not blocked): run WrenAI (docker compose) on
  real hardware; per-tenant WrenAI project + connection profile using the
  `bi_<tenant>` credentials above; its LLM can point at the existing
  Cloudflare Workers AI OpenAI-compatible endpoint. Isolation is already
  proven by this spike.
