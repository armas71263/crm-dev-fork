# RubberTrack Multi-Tenant Platform

A **sellable, multi-tenant CRM + AI analytics platform**: every tenant gets a full CRM suite, a self-serve dashboard builder over certified metrics, an AI assistant that only ever answers from their data, forecasts, deal win-probability, and a governed trust layer where **the AI proposes and humans decide**.

**Status: release candidate** — implementation phases 0–8 complete, each live-verified against real Supabase + a real LLM (Cloudflare Workers AI). Per-phase evidence lives in the commit history and [docs/implementation_plan.md](docs/implementation_plan.md).

## What's inside

| Area | What you get |
|---|---|
| **CRM** | Companies, contacts, leads, deals, activities/tasks + vertical template screens (order records, suppliers/customers, issues, attendance, checklists) |
| **Dashboards** | KPI strip, pipeline charts, volume forecast, **My dashboard**: pin any chat chart or certified metric as a *live* widget (stored as the query — never a stale screenshot), plus an add-metric picker |
| **Certified metrics** | `metric_definitions` registry — "pipeline value" defined once; the assistant, dashboard cards and API all run the same SQL, so the number is identical on every surface |
| **AI assistant** | Grounded chat (SSE streaming), charts on request, DB-backed conversation memory, read-only text-to-SQL behind hard guardrails |
| **Trust layer** | Evidence ledger + suggestions: the AI can *observe* and *propose* but never *write* records — a human accepts/rejects each change (audited); credential-free AI service (no DB credentials at all); durable budget-gated agent task queue; behavioral rules as versioned markdown skills |
| **Predictions** | Monthly volume/deal-value forecasting (damped-trend Holt ETS — safe on outliers) + interpretable deal win-probability (logistic model, coefficients a rep can act on) with an **opt-in Mitra foundation-model challenger** (`PREDICTIONS_USE_MITRA=1`, falls back to Logit on any failure) |
| **Insights** | Deterministic computed business lines (source of truth) + AI-written commentary that may only cite those numbers |
| **Metering** | Plans catalog (Free/Starter/Pro) with rolling-24h AI-token caps enforced by a 429 guard on every AI route; per-tenant usage summary |
| **Ops** | Prometheus `/metrics` (aggregate-only), `/health/deep` service matrix, Ops screen, PostHog product events (opt-in), per-tenant backup → restore drill (verified 10/10 tables) |

## Architecture

```
Next.js 14 web (:3000)  ──same-origin JWT proxies──┐
                                                   ▼
Fastify BFF (:4000)  ── verifies Supabase Auth JWTs (ES256); RLS-scoped
   │  │                                            data endpoints; plan caps;
   │  └── internal gateway (shared-secret, named SQL ops) ◄── AI service (:5000)
   │                                                holds NO DB credentials
   └── predictions service (:5100, Fastify + statsmodels)
                │
Supabase Postgres 17 — RLS pooled tenancy (set_config session GUC),
app_role / app_customer / app_readonly login roles, FORCE RLS
```

**Isolation principles** (each live-verified, see AGENTS.md):
- One pg pool per *login role* — RLS is the boundary; the GUC is set server-side.
- BI credentials (`bi_<tenant>` + hardcoded views) are tamper-proof by construction.
- Multi-tenant AI runs through a token-authed internal gateway — the AI process can't reach the database directly.

**LLM:** Cloudflare Workers AI (`@cf/qwen/qwen3.8-27b`) via the AI Gateway, with `bge-base-en-v1.5` 768-d embeddings. Falls back to a deterministic local provider when unconfigured — the platform works offline.

## Hardware requirements

| Machine | Spec | Notes |
|---|---|---|
| Dev / laptop (default stack, Mitra & Chronos OFF) | 2 vCPU, 4 GB RAM, ~3 GB disk | Runs web :3000, BFF :4000, AI :5000, predictions :5100 comfortably; Postgres + Auth are hosted on Supabase, so no local database. Node 22+, Python 3.12. |
| Mitra challenger (`PREDICTIONS_USE_MITRA=1`) | 16 GB RAM + NVIDIA GPU (≥8 GB VRAM) recommended; hard floor ≈8 GB RAM CPU-only | A real Mitra fit needs ~7 GB RAM and AutoGluon measures CPU fits at 12–63x GPU latency. Install `autogluon.tabular[mitra]>=1.6` (~5 GB with torch). Auto-falls back to Logit wherever it can't fit. |
| Chronos-Bolt forecasts (`PREDICTIONS_USE_CHRONOS=1`) | Same class as Mitra | Also deferred to real hardware; the default damped-ETS runs anywhere. |

## Running on your machine — step by step

Prerequisites: git, Node.js 22+, Python 3.12 with `uv` (or `python3.12 -m venv`), the `psql` client, a free Supabase account.

1. **Create a Supabase project** (supabase.com → New project). Note the project ref + region and save the DB password. **Uncheck "Automatically expose new tables"** — RLS is the tenant boundary; auto-exposed anon grants would punch through it.
2. **Configure**: `cp .env.example .env` and fill:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API; the service-role key is server-only)
   - Four **session-pooler** DSNs (Project Settings → Database → Connection string; port 5432 — never the transaction pooler 6543, never the IPv6-only direct DSN): `SUPABASE_DB_ADMIN_POOLER_URL` (`postgres.<ref>`) plus staff `app_role.<ref>`, customer `app_customer.<ref>`, read-only `app_readonly.<ref>`
   - `BFF_INTERNAL_TOKEN` — any long random string (`openssl rand -hex 32`)
   - Optional: `AI_PROVIDER=cloudflare` + `CLOUDFLARE_*` for the real LLM — without it, a deterministic local provider keeps every screen working
3. **Migrate**: `./infra/scripts/migrate.sh` — applies migrations 001–012 (idempotent, tracked in `app.schema_migrations`) and creates the `app_role` / `app_customer` / `app_readonly` login roles. Then set their passwords to match your DSNs:
   ```bash
   psql "$SUPABASE_DB_ADMIN_POOLER_URL" \
     -c "ALTER ROLE app_role LOGIN PASSWORD '<staff-pw>'" \
     -c "ALTER ROLE app_customer LOGIN PASSWORD '<customer-pw>'" \
     -c "ALTER ROLE app_readonly LOGIN PASSWORD '<readonly-pw>'"
   ```
4. **Install deps**:
   ```bash
   npm --prefix apps/bff ci && npm --prefix apps/ai ci && npm --prefix apps/web ci
   (cd apps/predictions && uv venv && uv pip install --python .venv/bin/python -r requirements.txt)
   ```
5. **Run**: `./scripts/dev.sh` — a watchdog that restarts any of the four services if it dies. Web: http://localhost:3000, BFF :4000, AI :5000, predictions :5100.
6. **First user**: Supabase dashboard → Authentication → Add user, then set its `app_metadata` (`{"tenant":"rubbertrack","role":"staff"}`; customers also get `"company"`) via the SQL editor or the Auth Admin API so the BFF knows the tenant. The live dev project already has `staff.rt@test.dev` / `staff.lex@test.dev` / `cust.ceat@test.dev` / `vendor@test.dev`, all `TestPass123!`.
7. **Sanity tests**: the three commands in the next section.

## Tests

```bash
cd apps/bff && npm test        # 80/80 — routing, RLS contracts, caps, suggestions, gateway security
cd apps/ai && npm test        # 29/29 — tools, gateway mocks, skills, SSE
cd apps/predictions && .venv/bin/python -m pytest   # 18/18 — forecaster + win-probability (Logit contract, Mitra challenger, API)
```

## Documentation

| Doc | Contents |
|---|---|
| [docs/implementation_plan.md](docs/implementation_plan.md) | The plan, phase by phase, with live-verification evidence |
| [AGENTS.md](AGENTS.md) | Engineering learnings + operational memory (RLS pitfalls, AI provider gotchas…) |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Deployment runbook |
| [docs/backup-restore.md](docs/backup-restore.md) | Tenant backup → restore drill (script + runbook) |
| [docs/observability.md](docs/observability.md) | Metrics, SigNoz/Uptime Kuma production steps, PostHog activation |
| [docs/spikes/wrenai-isolation.md](docs/spikes/wrenai-isolation.md) | BI credential isolation spike (passed) |

## Honest deferrals (documented, not faked)

Verified-on-production-hardware items: SigNoz OTel traces, a running Uptime Kuma instance, Chronos-Bolt forecast inference, and real Mitra fit accuracy — exact steps are in the runbooks; the sandbox lacks the RAM/CPU to exercise them. See [docs/observability.md](docs/observability.md).

---

⚠️ Demo credentials and secrets committed to this repo's history/environment are for development only — rotate everything (Supabase, Cloudflare, PostHog) before any public deployment.
