import pg from 'pg'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'url'
import path from 'path'
import { buildApp } from './app.js'

const PORT = parseInt(process.env.BFF_PORT || '4000', 10)
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:5000'

// Postgres pool as the non-superuser app_role so RLS applies.
const pool = new pg.Pool({
  host: process.env.PG_HOST || 'postgres',
  port: 5432,
  database: process.env.PG_DATABASE || 'rubbertrack',
  user: process.env.PG_USER || 'app_role',
  password: process.env.PG_PASSWORD || 'apppass',
})

// Privileged admin pool (postgres superuser) for the /tenants control plane.
const adminPool = new pg.Pool({
  host: process.env.PG_HOST || 'postgres',
  port: 5432,
  database: process.env.PG_DATABASE || 'rubbertrack',
  user: process.env.PG_ADMIN_USER || 'postgres',
  password: process.env.PG_ADMIN_PASSWORD || 'postgres',
})

const fastify = await buildApp({ pool, adminPool, aiServiceUrl: AI_SERVICE_URL })

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
