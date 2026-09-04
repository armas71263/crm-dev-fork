import pg from 'pg'
import { buildApp } from './app.js'

const PORT = parseInt(process.env.AI_PORT || '5000', 10)

// Connect as non-superuser app_role so RLS applies; tenant set per request.
const pool = new pg.Pool({
  host: process.env.PG_HOST || 'postgres',
  port: 5432,
  database: process.env.PG_DATABASE || 'rubbertrack',
  user: process.env.PG_USER || 'app_role',
  password: process.env.PG_PASSWORD || 'apppass',
})

const { app: fastify, snapshotAllTenants } = await buildApp({ pool })

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
