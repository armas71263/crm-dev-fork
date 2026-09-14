# Tenant backup & restore runbook (Phase 8, drill-verified 2026-09-14)

## Backup
Vendor-only endpoint: `GET /tenants/:id/backup` (JWT with role=vendor) → JSON dump
`{ tenant, backed_up_at, tables: { records: [...], ... } }`. Works against Supabase
(ten tables incl. embeddings vectors and jsonb payloads).

```bash
curl -H "authorization: Bearer <vendor-jwt>" https://<bff>/tenants/rubbertrack/backup > rt-dump.json
```

## Restore
`apps/bff/scripts/restore-tenant.mjs` restores a dump into a NEW tenant id
(never in-place — a restore must not overwrite live rows). Needs `SUPABASE_DB_ADMIN_POOLER_URL`.

```bash
cd apps/bff && node scripts/restore-tenant.mjs ../../rt-dump.json rt_restored --keep
```

- Registry row is created first (FK target); `label/template/tier` are copied.
- Row ids are dropped (fresh bigserial ids) — references stay consistent because
  CRM relations are name/uuid based, not row-id based.
- Every identifier is quoted — hr_events carries the reserved word `leave`.
- Default mode is a DRILL: restores, verifies per-table counts, then cleans up.
  `--keep` keeps the restored tenant.

## Drill evidence (2026-09-14, live)
rubbertrack dump (190 rows: records 76, parties 9, tickets 6, feed_items 5,
checklists 1, files 0, hr_events 5, screen_configs 1, embeddings 35, ai_usage_logs 52)
restored into scratch tenant `restore_drill` — **all 10 tables matched 100%** — then cleaned up.
