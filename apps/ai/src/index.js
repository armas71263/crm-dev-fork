import Fastify from 'fastify'

const fastify = Fastify({ logger: true })
const PORT = parseInt(process.env.AI_PORT || '5000', 10)

fastify.get('/health', async () => ({ ok: true, service: 'ai' }))

// Assistant endpoint — stub: wires Vercel AI SDK + providers + tenant scope here
fastify.post('/chat', async (req, reply) => {
  const { message } = req.body || {}
  const tenantId = req.headers['x-tenant-id']
  // TODO: plug Vercel AI SDK 5 with provider router + tenant-scoped tools
  reply.send({ reply: `Assistant stub — tenant ${tenantId || 'unknown'} said: ${message || ''}` })
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
