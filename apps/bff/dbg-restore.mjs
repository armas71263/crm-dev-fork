import pg from 'pg'
import fs from 'fs'
const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_ADMIN_POOLER_URL, max: 2, ssl: { rejectUnauthorized: false } })
const dump = JSON.parse(fs.readFileSync('/tmp/devstack/backup.json', 'utf8'))
const SC = 'restore_drill'
try {
  await pool.query("INSERT INTO app.tenants (id, label, template, tier, status, plan_key) VALUES ('restore_drill','Restore Drill', (SELECT template FROM app.tenants WHERE id='rubbertrack'), (SELECT tier FROM app.tenants WHERE id='rubbertrack'), 'active','free') ON CONFLICT DO NOTHING")
  for (const [table, rows] of Object.entries(dump.tables)) {
    for (const row of rows) {
      row.tenant_id = SC
      delete row.id
      const cols = Object.keys(row)
      const colList = cols.map((c) => '"' + c + '"').join(',')
      const params = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]))
      try {
        await pool.query(`INSERT INTO ${table} (${colList}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, params)
      } catch (e) {
        console.log('ROW FAIL', table, '::', e.message)
        process.exit(1)
      }
    }
  }
  let allMatch = true
  for (const [table, rows] of Object.entries(dump.tables)) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [SC])
    const ok = r.rows[0].n === rows.length
    if (!ok) allMatch = false
    console.log('  ' + table + ': ' + r.rows[0].n + '/' + rows.length + (ok ? ' OK' : ' MISMATCH'))
  }
  console.log('VERIFY:', allMatch ? 'PASS' : 'FAIL')
  for (const table of Object.keys(dump.tables)) await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [SC])
  await pool.query("DELETE FROM app.tenants WHERE id='restore_drill'")
  console.log('cleanup done')
} finally { await pool.end() }
