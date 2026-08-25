# Tenant Isolation (How Client A Can't See Client B)

This is the most important section because selling the same platform to multiple clients means one leaking client is a critical failure.

## Layer 1 — Postgres RLS (enforced at DB level)

**Every request touches the DB with a tenant scope.** Example:

User logs in as `rubbertrack` → the app sets `SET LOCAL app.tenant_id = 'rubbertrack'`.

Even if the app's code has a bug (worst case), the DB rejects wrong rows.

Proof via tests (pgTAP or integration tests):
```
user: rubbertrack
expected: rows only for rubbertrack returned
```

## Layer 2 — Directus presets

Directus enforces `tenant_id` at creation and filtering (e.g., preset: `$CURRENT_USER.tenant_id`). We also run it inside transactions to avoid pool leakage across requests.

## Layer 3 — BFF check (defense)

Our gateway validates JWT claims before forwarding.

## Tiering per client

- **Tier A (default)**: shared DB + RLS (rubbertrack, grocercorp etc. all in one DB).
- **Tier B (schema-per-tenant)**: when client is heavy or needs schema-level customization.
- **Tier C (db-per-tenant)**: when client is regulated or pays premium.

## Isolation tests we run into CI

1. *Test A*: 2 tenants trying to read/write each other's rows. Expected: permission denied.
2. *Test B*: A `tenant-admin` cannot see collections of another tenant.
3. *Test C*: A `staff-*` user cannot use the Directus admin UI.
4. *Test D*: An `external customer` only accesses own company rows.
5. *Test E*: An AI Assistant is unable to use a tool without tenant scope injection.

## A runbook (if there's a device issue)

1. Check recent changes (schema/UI/flow).
2. Run the isolation test suite locally.
3. If confirmed leak: enable tenant's audit-log and rotate API keys.
4. Move affected tenant to Tier B (schema-level) or C (db-level) for isolation hardening.
5. Present short incident report with exact root block and safeguard fix.
