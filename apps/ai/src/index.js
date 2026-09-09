import pg from 'pg'
import { buildApp } from './app.js'

const PORT = parseInt(process.env.AI_PORT || '5000', 10)

// Staff pool: non-superuser app_role so RLS applies; tenant set per request.
// Supabase session-pooler DSNs need TLS (node-pg does not negotiate it itself);
// local compose runs keep the plain host config.
const DB_SESSION_POOLER = process.env.SUPABASE_DB_SESSION_POOLER_URL
const pool = DB_SESSION_POOLER
  ? new pg.Pool({ connectionString: DB_SESSION_POOLER, max: 5, ssl: { rejectUnauthorized: false } })
  : new pg.Pool({
      host: process.env.PG_HOST || 'postgres',
      port: 5432,
      database: process.env.PG_DATABASE || 'rubbertrack',
      user: process.env.PG_USER || 'app_role',
      password: process.env.PG_PASSWORD || 'apppass',
    })

// Read-only pool for the text-to-SQL tool: the app_readonly LOGIN role —
// SELECT-only grants + tenant-isolation RLS (fail-closed without the GUC),
// so generated SQL is safe by construction. Optional: the tool 503s without it.
const READONLY_DSN = process.env.SUPABASE_DB_READONLY_POOLER_URL
const readonlyPool = READONLY_DSN
  ? new pg.Pool({ connectionString: READONLY_DSN, max: 3, ssl: { rejectUnauthorized: false } })
  : null

const { app: fastify, snapshotAllTenants } = await buildApp({ pool, readonlyPool })

// Run on start + on a schedule (default every 30 min; INSIGHTS_INTERVAL_MS overrides).
const SNAPSHOT_INTERVAL = parseInt(process.env.INSIGHTS_INTERVAL_MS || '1800000', 10)
setTimeout(snapshotAllTenants, 5000)
setInterval(snapshotAllTenants, SNAPSHOT_INTERVAL)

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}
start()
