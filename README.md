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
| **Predictions** | Monthly volume/deal-value forecasting (damped-trend Holt ETS — safe on outliers) + interpretable deal win-probability (logistic model, coefficients a rep can act on) |
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

## Quickstart

```bash
cp .env.example .env            # then fill Supabase + provider keys (see below)
./infra/scripts/migrate.sh      # applies migrations 001–012 (idempotent, tracked)
./scripts/dev.sh                # supervises BFF :4000, AI :5000, predictions :5100, web :3000
```

Open http://localhost:3000. Demo users (seeded in the live project, password `TestPass123!`):
`staff.rt@test.dev` (tenant admin) · `staff.lex@test.dev` · `cust.ceat@test.dev` (customer portal) · `vendor@test.dev` (vendor plane).

Required env (beyond Supabase): `BFF_INTERNAL_TOKEN` (internal gateway secret). Optional but recommended: `AI_PROVIDER=cloudflare` + `CLOUDFLARE_*` keys, `POSTHOG_API_KEY`.

## Tests

```bash
cd apps/bff && npm test        # 80/80 — routing, RLS contracts, caps, suggestions, gateway security
cd apps/ai && npm test        # 29/29 — tools, gateway mocks, skills, SSE
cd apps/predictions && .venv/bin/python -m pytest   # 5/5 — forecaster + win-probability
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

Verified-on-production-hardware items: SigNoz OTel traces, a running Uptime Kuma instance, and Chronos-Bolt forecast inference — exact steps are in the runbooks; the sandbox lacks the RAM/CPU to exercise them. See [docs/observability.md](docs/observability.md).

---

⚠️ Demo credentials and secrets committed to this repo's history/environment are for development only — rotate everything (Supabase, Cloudflare, PostHog) before any public deployment.
