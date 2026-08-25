# Architecture Overview

```
┌─────────────────── Frontend (Next.js PWA) ───────────────────┐
│ React + shadcn/ui + Recharts + Vercel AI SDK useChat          │
│ · Bespoke Figma-designed screens                             │
│ · Responsive card/table layouts                              │
│ · AI Assistant panel, Doc checker wizard                     │
│ · Refine headless behind for easy scaffolding                │
└──────────────────────────────────┬───────────────────────────┘
                                   │
┌────────────────────────────── ▼ ─────────────────────────────┐
│ Skinny BFF (thin backend inside same Docker)               │
│ · Tenant detection from auth token                          │
│ · Issue tokens after auth                                   │
│ · Route AI orchestrator requests                             │
│ · Audit logging                                              │
└──────────────────────────────┬──────────────────────────────┘
                               │
        ┌──────────────────────▼──────────────────────┐
        │ Directus Control Plane                      │
        │  · REST + GraphQL API for all data           │
        │  · Admin UI (you/tenant-admin)               │
        │  · Auth + Roles (RBAC)                       │
        │  · Files storage                             │
        └──────────────┬───────────────┬──────────────┘
                       │               │
                DB layer              AI layer
                       │               │
        ┌──────────────▼──────┐  ┌────▼─────────────┐
        │ Supabase Postgres   │  │ AI Orchestrator  │
        │ · pgvector, tsvector│  │  Vercel AI SDK   │
        │ · RLS (tenant split)│  │  planner→tools   │
        └─────────────────────┘  │  synthesis→answer│
                                  └──────────────────┘
```

## Read this in plain words

1. **User opens your app** → sees a login screen.
2. **Login** (Directus auth) → assigned roles (privileged-admin, tenant-admin, staff-*, customer).
3. **App fetches data** via Directus → every request carries the tenant id. Postgres RLS filters rows at DB level (Decision 1).
4. **User queries AI assistant** → BFF routes to AI orchestrator. Planner picks tools, tools query DB with tenant filter, synthesis computes answer (Decision 2).
5. **Admin/clients on Directus UI** — tenant admin can customize collections/screens/roles within own tenant (Decision 3).

## Long view (deployment choices)

1. Simplest: one Docker compose on one VPS: frontend + BFF + Directus + AI service.
2. Managed PG: Supabase (pgvector!). Neon works too.
3. Edge later: frontend on Cloudflare Pages; AI service → Workers AI.

## Key security pattern

- Tenant isolation is enforced at **3 layers** (DB RLS, Directus presets, BFF check) — defense-in-depth.
- Directus admin UI accessible only to privileged-admin and tenant-admin roles.
- Staff and customers NEVER see the Directus Admin UI. They always see your custom screens.

## Availability of modules per tenant

Screens (dashboard, doc checker, diff checker, news feed, etc.) are enabled/disabled per template/configs (Decision 4). A "Trading" client gets doc-checker; a "Services" client gets tickets; a "Retail" client gets inventory — same engine, differing modules on.
