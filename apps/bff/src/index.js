import pg from 'pg'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'url'
import path from 'path'
import { buildApp, createAuthVerifier } from './app.js'

const PORT = parseInt(process.env.BFF_PORT || '4000', 10)
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:5000'

// Postgres pool as the non-superuser app_role so RLS applies.
// Supabase: use the SESSION pooler URL (never the transaction pooler — it breaks
// the session-level set_config RLS pattern). Small max: free-tier connection limits.
const DB_SESSION_POOLER = process.env.SUPABASE_DB_SESSION_POOLER_URL
const pool = DB_SESSION_POOLER
  ? new pg.Pool({ connectionString: DB_SESSION_POOLER, max: 5 })
  : new pg.Pool({
      host: process.env.PG_HOST || 'postgres',
      port: 5432,
      database: process.env.PG_DATABASE || 'rubbertrack',
      user: process.env.PG_USER || 'app_role',
      password: process.env.PG_PASSWORD || 'apppass',
    })

// Privileged admin pool (postgres superuser) for the /tenants control plane.
const adminPool = DB_SESSION_POOLER
  ? new pg.Pool({ connectionString: DB_SESSION_POOLER, max: 5 })
  : new pg.Pool({
      host: process.env.PG_HOST || 'postgres',
      port: 5432,
      database: process.env.PG_DATABASE || 'rubbertrack',
      user: process.env.PG_ADMIN_USER || 'postgres',
      password: process.env.PG_ADMIN_PASSWORD || 'postgres',
    })

// Customer pool: customer-role JWTs run on the app_customer LOGIN role —
// current_user is the isolation boundary (migration 003 explains why SET ROLE
// membership cannot be used). Same connection shape as the staff pool.
const CUSTOMER_DSN = process.env.SUPABASE_DB_CUSTOMER_POOLER_URL
const customerPool = CUSTOMER_DSN
  ? new pg.Pool({ connectionString: CUSTOMER_DSN, max: 5 })
  : new pg.Pool({
      host: process.env.PG_HOST || 'postgres',
      port: 5432,
      database: process.env.PG_DATABASE || 'rubbertrack',
      user: process.env.PG_CUSTOMER_USER || 'app_customer',
      password: process.env.PG_CUSTOMER_PASSWORD || 'apppass',
    })

// Auth: production boots require SUPABASE_URL so JWT verification is always on.
// Dev mode (header-based tenant selection) is only reachable by explicit opt-in,
// never by a missing variable in production.
let auth = null
if (process.env.SUPABASE_URL) {
  auth = createAuthVerifier({ supabaseUrl: process.env.SUPABASE_URL })
} else if (process.env.BFF_ALLOW_DEV_AUTH !== '1') {
  console.error('FATAL: SUPABASE_URL is required (or set BFF_ALLOW_DEV_AUTH=1 for local dev only)')
  process.exit(1)
} else {
  console.warn('BFF running in DEV AUTH mode (x-tenant-id header) — never use in production')
}

const fastify = await buildApp({ pool, customerPool, adminPool, aiServiceUrl: AI_SERVICE_URL, auth })

const start = async () => {
  try {
    // Serve the static preview/ UI from the BFF so a single tunnel exposes both.
    const dir = path.resolve(fileURLToPath(import.meta.url), '../../preview')
    await fastify.register(fastifyStatic, { root: dir, prefix: '/' })
    await fastify.listen({ port: PORT, host: '0.0.0.0' })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}
start()
