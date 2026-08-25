import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'

const fastify = Fastify({ logger: true })
const PORT = parseInt(process.env.BFF_PORT || '4000', 10)

await fastify.register(cors, { origin: true })
await fastify.register(helmet)

fastify.get('/health', async () => ({ ok: true, service: 'bff' }))

// Tenant-detection middleware — stub: resolves tenant from Authorization header in v2
fastify.addHook('preHandler', async (req, reply) => {
  // TODO: parse JWT (Directus) and set req.tenantId; for dev, accept header for testing
  req.tenantId = req.headers['x-tenant-id'] || null
})

// Proxy to AI service (approve the AI contexts)
fastify.post('/ai/chat', async (req, reply) => {
  const res = await fetch(`${process.env.AI_SERVICE_URL || 'http://localhost:5000'}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': req.tenantId },
    body: JSON.stringify(req.body)
  })
  reply.send(await res.text())
})

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}
start()
