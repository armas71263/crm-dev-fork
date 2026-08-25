# RubberTrack Multi-Tenant CRM/CMS/Dashboard Build Handbook

**Approved decisions:** Tenancy=RLS+tiered escalation · AI=Vercel AI SDK v5+LlamaIndex.TS+OpenRouter/NIM/Ollama/Workers · Control plane=Directus 12 · Templates=RubberTrack+generic Services

---

## 1. SYSTEM OVERVIEW

A multi-tenant business platform sold to multiple clients. Tenant (e.g., RubberTrack) is a template-driven deployment on shared infra with database-enforced isolation.

```
┌─── Frontend (Next.js 14 PWA) ────────────────────────────┐
│ React + shadcn/ui + Recharts + Vercel AI SDK useChat     │
│ Bespo-designed screens per tenant template              │
│ Refine headless behind (scaffold helper)                │
└────────────────────────────────┬──────────────────────────┘
                                 │
┌────────────────────────────────▼──────── BFF (Fastify) ─┐
│ Tenant detection, auth with Directus                   │
│ AI route proxying, audit logging                         │
│ Signed for top-level RLS enforced at DB layer          │
└────────────────────────────────┬──────────────────────────┘
                                 │
        ┌────────────────────────▼───────────────────────┐
        │               Directus (control plane)          │
        │  Admin UI + REST/GraphQL + Auth/RBAC + Files    │
        └────────────────────────┬───────────────────────┘
                                 │
            ┌────────────────────▼───────────────────┐
            │     Supabase Postgres (managed)         │
            │  pgvector + tsvector + trgm             │
            │  tenant_id tagging + Row-Level Security │
            │  JSONB for tenant-spec data             │
            └───────────────────────────────────────┘
                              AI Orchestrator
                    ┌───────────▼───────────────┐
                    │ Vercel AI SDK v5 (agent)  │
                    │ LlamaIndex.TS (ingest)    │
                    │ OpenRouter (LLM)          │
                    │ NVIDIA NIM (embeddings)   │
                    │ Ollama (local dev)        │
                    │ Workers AI (edge)         │
                    └───────────────────────────┘
```

---

## 2. STACK & PINS

| Layer | Selected | Version/pin | Purpose |
|-------|----------|-------------|---------|
| Managed Postgres | **Supabase** (openalternative) | v17+ | pgvector, tsvector, trgm ready |
| Backend/API/Admin/UI/RBAC/Auth | **Directus** (openalternative) | `directus:12.x` | control plane |
| Frontend | **Next.js 14 + React 18 + shadcn/ui + Recharts + Refine headless** | `next@14`, `shadcn`, `recharts`, `@refinedev/core@5` | Figma screens, dashboard |
| AI orchestration | **Vercel AI SDK v5** (own research, own research) | `ai@5.x` | agentic chat/planner/tools |
| Ingestion & retriev | **LlamaIndex.TS** | `llamaindex@latest` | RAG/doc pipeline |
| Providers | **OpenRouter** primary (LLM), **NVIDIA NIM** (embeddings), **Ollama** (dev), **Cloudflare Workers** (edge) | bound by tenant | model routing |

---

## 3. TENANT ONBOARDING (OPERATIONS)

1. Clone template (RubberTrack or Services).
2. Run script → tenant row + roles + permission presets + collections + seed.
3. Configure theme/labels/roles per tenant.
4. Tier A default (RLS). Tier B/C script when heavy/regulated.

---

## 4. TEMPLATES DEFINE WHAT TURNS ON

| Module | Kind | RubberTrack | Services |
|---|---|---|---|
| Dashboard | su | ✔ | ✔ |
| Records | su | ✔ | ✔ |
| Parties (Customers/Suppliers) | su | ✔ | ✔ |
| Issues/Tickets | su | ✔ | ✔ |
| Attendance | su | ✔ | optional |
| News & Updates (CMS) | su | ✔ | ✔ |
| Doc Checker (AI) | su | ✔ | ✔ |
| Diff Checker | su | ✔ | ✔ |
| Checklists | su | ✔ | ✔ |
| Pending Documents | su | ✔ | ✔ |
| AI Assistant | su | ✔ | ✔ |

---

## 5. PHASED BUILD PLAN (with exit criteria per phase)

### Phase 0 — Scaffold (1 week)
- Supabase project + extension pgvector
- docker-compose: directus + frontend + bff + ai service + mock auth
- tenancy helper SQL `current_tenant()` + RLS policies on every entity
- Onboarding script → clone template, statuses, roles, permission presets
- roles: `privileged-admin`, `tenant-admin`, `staff-*`, `customer`

### Phase 1 — Template Engine (2 weeks)
- Dynamic module registry (enabled per tenant template)
- RLS-aware Directus SDK hooks for custom screens
- RubberTrack demo template reproducing ALL Figma screens
- Import/Export Excel, screen-config editor (choose charts/cards)
- Generic Services template optional in parallel

### Phase 2 — Dashboard + Hybrid Search (2 weeks)
- KPI engine (compute from DB, watch YoY)
- Chart builder with config-in-DB
- pgvector + tsvector + trgm hybrid search w/ merge+re-rank
- Global Search UI

### Phase 3 — AI Platform (3 weeks)
- Provider router (OpenRouter/NIM/Ollama) w/ tenant config
- Assistant: planner→tools→synthesis, streaming UI
- Insights generator (nightly + on-demand)
- Doc Checker (extraction), Diff (side-by-side + flag mismatches)
- AI usage logs (costs/tools per tenant)

### Phase 4 — Ops/Tenancy Escalation (2 weeks)
- Tenant-onboarding automation & cloning
- Schema-per-tenant / DB-per-tenant escalation script
- Per-tenant logical backup
- Isolation tests in CI

### Phase 5 — White-label + release (2 weeks)
- per-tenant branding (theme.json in DB)
- External customer portal (login→scoped views)
- Deployment runbooks
- Demo-reset pipeline

---

## 6. SAMPLE TEMPLATE SCHEMA (RubberTrack)

Collections (in tenant template JSON):

- `records` — order/master data. eg `order_id`, `date`, `customer`, `supplier`, `grade`, `mt`, `fcl`, `price_usd`, `status`, `tenant_id`, JSONB `extra`
- `parties` — `type` psvod/`customer`; contact info, tags, embedding of details for assistant
- `tickets` — `category`, `status`, `description`, fields for `kind` like `quality/shipment/doc`
- `hr_events` — employee, department, attendance fields
- `feed_items` — category, title, description, priority
- `checklists` — customer/supplier-specific checklist sets
- `files` — uploads and associations
- `embeddings` — unified schema per Cerebras blog (source_type, source_id, vector, metadata, tenant_id)

Labels provided: `records`→`Order Records`, `parties_customer`→`Customers`, `parties_supplier`→`Suppliers`.

---

## 7. TENANT ISOLATION TESTS (proof)

- Test A: 2 tenants attempting read/write cross — expect deny.
- Test B: tenant-admin sees own collections only.
- Test C: staff cannot use Directus admin UI.
- Test D: external customer only sees own company rows.
- Test E: AI tools must inject tenant scope.

---

## 8. SECURITY RAC MATRIX

| Role | Rest | Admin UI | Scope |
|---|---|---|---|
| `privileged-admin` | all layers | Full | system+templates |
| `tenant-admin` | within tenant | Full within tenant | roles+data |
| `staff-sales` | within tenant | No | sales records |
| `staff-logistics` | within tenant | No | ops records |
| `staff-documentation` | within tenant | No | docs |
| `staff-technical` | within tenant | No | tickets |
| `customer` | within tenant and own company | No | own documents |

---

## 9. APPENDIX — Where each file lives post-scaffold

```
workspace/project/
├── docker-compose.yml
├── .env.example
├── docs/
│   └── build_handbook.md
├── apps/
│   ├── web/   ← Next.js + Refine headless + shadcn/ui
│   ├── bff/   ← Fastify, tenant-detection + AI-proxy
│   └── ai/    ← Vercel AI SDK + LlamaIndex + provider router
├── infra/
│   ├── tenancy/helper.sql      ← pg function + RLS
│   ├── templates/rubbertrack.json
│   └── scripts/normalize.sh
└── README.md
```

---

## END OF HANDBOOK

**Signatories**: celebrate under (privileged-admin) & project sponsor — both approvals on the 4 decisions recorded.
