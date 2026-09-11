import { buildApp } from './app.js'

const PORT = parseInt(process.env.AI_PORT || '5000', 10)

// Credential-free agent (Phase 6.5): this service holds NO database
// credentials — no pg import, no pools. Every DB touch goes through the BFF's
// internal gateway (shared-secret token, RLS-scoped, SQL defined server-side).
const BFF_URL = process.env.BFF_INTERNAL_URL || process.env.BFF_URL || 'http://localhost:4000'
const INTERNAL_TOKEN = process.env.BFF_INTERNAL_TOKEN

if (!INTERNAL_TOKEN) {
  console.error('FATAL: BFF_INTERNAL_TOKEN is required (the internal gateway refuses unauthenticated callers)')
  process.exit(1)
}

const gateway = async (tenantId, op, params = {}) => {
  if (op === '__sql') {
    const res = await fetch(`${BFF_URL}/internal/sql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN, 'x-tenant-id': tenantId },
      body: JSON.stringify({ sql: params.sql }),
    })
    return await res.json()
  }
  const res = await fetch(`${BFF_URL}/internal/data`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN, 'x-tenant-id': tenantId },
    body: JSON.stringify({ op, params }),
  })
  return await res.json()
}

const { app: fastify, snapshotAllTenants } = await buildApp({ gateway })

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
