# Decision 1: How We Separate Each Client's Data (Tenancy)

## The Problem

You're going to sell this to many clients. RubberTrack is client 1. Another client could be, say, "GrocerCorp" (retail inventory). Another, "MediSafe Clinics". Each has different data (orders vs. patients vs. SKUs), different staff roles, and MUST NOT see each other's data.

"Tenancy" = how we keep each client separate and safe.

---

## How it works — three tiers (like apartments, floors, separate buildings)

### Tier A — Default: Everyone in one database, each row tagged by tenant

**Idea**: One shared Postgres database. Every table has a `tenant_id` column (like an apartment number). When RubberTrack asks "show me my orders", the database answers only rows where `tenant_id = 'rubbertrack'`.

The enforcement is done at the **database level** using Postgres "Row-Level Security" (RLS). Even if our app code has a bug, the database blocks cross-client access anyway. That's the safety net.

**Analogy**: An apartment building. One building, each flat has a lock. Cheap, fast, and good enough for most clients initially.

**Concrete example** (two clients, table `records`):

| id | tenant_id | entity | grade | mt | customer |
|----|-----------|--------|-------|----|----------|
| 1 | rubbertrack | order | TSR-20 | 100.8 | JK Tyre |
| 2 | rubbertrack | order | STR-20 | 2240 | CEAT |
| 3 | grocer-corp | product | skincare | 340 | Metro store |
| 4 | grocer-corp | product | snacks | 220 | B2B |

RLS policy (Postgres blocks wrong rows at DB level):

```sql
CREATE POLICY "tenant_isolation" ON records
  FOR ALL TO app_users
  USING (tenant_id = current_setting('app.tenant_id'));
```

Every user's request carries `SET app.tenant_id = 'rubbertrack'` and the database refuses to see rows of `grocer-corp`.

### Tier B — Middle: Each tenant gets its own schema (separate floor)

**Idea**: Heavy client or one with compliance needs gets a dedicated "schema" (a named partition of the same DB). Same server, separate space. Easier customizations (extra tables per client), per-tenant backups.

**Analogy**: You move the VIP from the shared building to their own floor.

### Tier C — Strict: Each tenant gets its own database (separate building)

**Idea**: Fully separate Postgres DB (optionally separate Directus project too). Strongest isolation + own backup/export. Needed for a regulated/heavy client.

**Analogy**: You build them their own house.

---

## How we choose the tier

- Start **all new clients on Tier A (RLS + tenant_id)**.
- **Move to Tier B** when:
  - The client needs schema-level customizations beyond templates.
  - They want per-tenant logical backups.
  - They have > ~50 GB of data or heavy query volume.
- **Move to Tier C** for:
  - Regulated industries (healthcare, finance, government).
  - Clients paying for "own-server" level isolation.

We keep the same application code; the database routing changes.

## Trade-offs at a glance

| Tier | Cost | Isolation strength | Who it's for |
|------|------|--------------------|--------------|
| A — shared schema + RLS | $ | Medium | Most clients, initially |
| B — schema-per-tenant | $$ | Strong | Heavy / personalized clients |
| C — db-per-tenant | $$$ | Strongest | Regulated or "bundle-price" clients |

## What we build (concrete)

- SQL migration creating a helper function `current_tenant()` + RLS policies on every entity.
- A tenant onboarding script that runs `SET app.tenant_id` per request, and an escalation script (Tier A → Tier B/C).
- Database tests simulating each client's users to prove no cross-tenant leakage.

**Decision question**: Do you agree all this happens automatically (RLS now, escalation scripts ready) and I implement the helper + the tests? (Yes/No)
