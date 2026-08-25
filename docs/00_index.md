# Platform Design Documents

These documents explain each architectural decision in plain language, with examples.

## The 4 Decisions You Need to Approve

| # | Decision | Document |
|---|----------|----------|
| 1 | **How we separate each client's data** (tenancy) | [decisions/01-tenancy](decisions/01_tenancy.md) |
| 2 | **How the AI features work** (assistant, insights, doc parsing) | [decisions/02-ai](decisions/02_ai.md) |
| 3 | **What Directus does** (admin panel, login, permissions, API) | [decisions/03-control-plane](decisions/03_control_plane.md) |
| 4 | **Which client templates we start with** | [decisions/04-templates](decisions/04_templates.md) |

## Background Docs

- [architecture/overview.md](architecture/overview.md) — the whole system picture
- [roles/rbac.md](roles/rbac.md) — who can do what (privileged-admin, tenant-admin, staff, customer)
- [tenancy/isolation.md](tenancy/isolation.md) — data separation tiers A/B/C explained

## Approval Status

| # | Decision | Status |
|---|---|---|
| 1 | Tenancy (RLS + escalation tiers) | PENDING |
| 2 | AI frameworks (Vercel AI SDK + LlamaIndex.TS + providers) | PENDING |
| 3 | Directus as control plane | PENDING |
| 4 | Initial templates (RubberTrack + generic Services) | PENDING |
