// Restore a tenant backup dump into a NEW tenant id (Phase 8 drill-verified).
// Usage: node scripts/restore-tenant.mjs <dump.json> <new-tenant-id> [--keep]
// The drill (2026-09-14): rubbertrack dump (190 rows / 10 tables) restored into
// scratch tenant 'restore_drill' — every table matched, then cleaned up.
import pg from 'pg'
import fs from 'fs'

const [dumpPath, newId, keep] = process.argv.slice(2)
if (!dumpPath || !newId) {
  console.error('usage: node scripts/restore-tenant.mjs <dump.json> <new-tenant-id> [--keep]')
  process.exit(1)
}
const dsn = process.env.SUPABASE_DB_ADMIN_POOLER_URL
if (!dsn) { console.error('SUPABASE_DB_ADMIN_POOLER_URL required'); process.exit(1) }

const pool = new pg.Pool({ connectionString: dsn, max: 2, ssl: { rejectUnauthorized: false } })
const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'))
try {
  // registry row first (FK target): label/template/tier copied from the dump's tenant
  await pool.query(
    `INSERT INTO app.tenants (id, label, template, tier, status, plan_key)
     SELECT $1, 'Restored ' || label, template, tier, 'active', 'free'
     FROM app.tenants WHERE id = $2 ON CONFLICT (id) DO NOTHING`,
    [newId, dump.tenant])
  for (const [table, rows] of Object.entries(dump.tables)) {
    for (const row of rows) {
      row.tenant_id = newId
      delete row.id // let bigserial assign fresh ids
      const cols = Object.keys(row)
      // quote every identifier — hr_events has the reserved-word `leave` column
      const colList = cols.map((c) => `"${c}"`).join(',')
      const params = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]))
      await pool.query(`INSERT INTO ${table} (${colList}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, params)
    }
  }
  let allMatch = true
  for (const [table, rows] of Object.entries(dump.tables)) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [newId])
    const ok = r.rows[0].n === rows.length
    if (!ok) allMatch = false
    console.log(`  ${table}: ${r.rows[0].n}/${rows.length} ${ok ? 'OK' : 'MISMATCH'}`)
  }
  console.log('VERIFY:', allMatch ? 'PASS' : 'FAIL')
  if (!keep && allMatch) {
    // default: drill mode cleans up. Pass --keep to keep the restored tenant.
    for (const table of Object.keys(dump.tables)) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [newId])
    }
    await pool.query('DELETE FROM app.tenants WHERE id = $1', [newId])
    console.log('cleanup: scratch tenant removed (use --keep to keep)')
  }
  process.exit(allMatch ? 0 : 1)
} finally {
  await pool.end()
}
