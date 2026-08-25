# RubberTrack Multi-Tenant Platform

A multi-tenant CRM/CMS/dash platform you sell to multiple clients. Built with:

- **Directus 12** — Admin UI + REST/GraphQL + auth + RBAC + files (control plane)
- **Next.js + shadcn/ui + Refine headless + Recharts** — bespoke screens per tenant template
- **Supabase Postgres** — pgvector + tsvector + trgm + RLS (tenant split)
- **Vercel AI SDK v5 + LlamaIndex.TS** — agentic assistant, Insights, doc pipeline
- **Providers**: OpenRouter, NVIDIA NIM, Ollama, Cloudflare Workers

## Quickstart

```bash
cp .env.example .env
docker compose up -d
# after start: admin@example.com / admin1234
docker exec -it $(docker ps -q -f name=directus) npx directus-template-cli@latest init /directus/snapshots
```

### 1) Bootstrap a tenant

```bash
node apps/bff/scripts/onboard-tenant.js rubbertrack --template=rubbertrack
```

### 2) Enable RLS (per client)

```bash
psql $DATABASE_URL -f infra/tenancy/helper.sql
```

### 3) Run isolation tests

```bash
node apps/bff/scripts/isolation-test.js
```

## Docs

See [`docs/00_index.md`](docs/00_index.md) (or open served `docs/...html`).

## Approvals

- Decision 1: Tenancy RLS + tiers — approved
- Decision 2: Vercel AI SDK v5 + LlamaIndex.TS + providers — approved
- Decision 3: Directus control plane — approved
- Decision 4: RubberTrack + Services templates — approved
