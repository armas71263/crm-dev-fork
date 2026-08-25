import Fastify from 'fastify'
import pg from 'pg'
import crypto from 'crypto'

const fastify = Fastify({ logger: true })
const PORT = parseInt(process.env.AI_PORT || '5000', 10)
const DIM = 768

// Connect as non-superuser app_role so RLS applies; tenant set per request.
const pool = new pg.Pool({
  host: process.env.PG_HOST || 'postgres',
  port: 5432,
  database: process.env.PG_DATABASE || 'rubbertrack',
  user: process.env.PG_USER || 'app_role',
  password: process.env.PG_PASSWORD || 'apppass',
})

// Deterministic local embedding (hashing trick over token 3-grams, L2-normalized).
// Offline + tenant-safe; swap for a hosted embedder (Vercel AI SDK `embed()`) when
// an LLM key is configured — the vector shape stays identical.
function embed(text) {
  const v = new Float64Array(DIM)
  const tokens = String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const grams = []
  for (let i = 0; i < tokens.length; i++) {
    grams.push(tokens[i])
    if (i > 0) grams.push(tokens[i - 1] + ' ' + tokens[i])
    if (i > 1) grams.push(tokens[i - 2] + ' ' + tokens[i - 1] + ' ' + tokens[i])
  }
  for (const g of grams) {
    const h = crypto.createHash('sha256').update(g).digest()
    const idx = h.readUInt32BE(0) % DIM
    const sign = h[4] % 2 === 0 ? 1 : -1
    v[idx] += sign
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return Array.from(v, (x) => x / norm)
}

async function tenantQuery(tenantId, text, params = []) {
  const client = await pool.connect()
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId])
    return await client.query(text, params)
  } finally {
    await client.query('RESET app.tenant_id')
    client.release()
  }
}

fastify.get('/health', async () => ({ ok: true, service: 'ai' }))

// Reindex a tenant's knowledge base into the embeddings table.
fastify.post('/index', async (req) => {
  const tenantId = req.headers['x-tenant-id']
  if (!tenantId) return { error: 'x-tenant-id required' }
  const sources = []
  const recs = await tenantQuery(tenantId,
    `SELECT order_id AS id, 'record' AS type,
            'Order '||order_id||': '||customer||' buying '||mt||' MT of '||grade||' from '||supplier||' at $'||price_usd||'/MT, status '||status AS text
     FROM records`)
  sources.push(...recs.rows)
  const tix = await tenantQuery(tenantId,
    `SELECT ticket_id AS id, 'ticket' AS type,
            'Ticket '||ticket_id||' ('||category||', '||status||'): '||description AS text
     FROM tickets`)
  sources.push(...tix.rows)
  const parties = await tenantQuery(tenantId,
    `SELECT name AS id, 'party' AS type,
            type||' '||name||' contact '||coalesce(contact->>'name', contact::text, 'n/a') AS text
     FROM parties`)
  sources.push(...parties.rows)

  await tenantQuery(tenantId, 'DELETE FROM embeddings')
  let indexed = 0
  for (const s of sources) {
    const vec = embed(s.text)
    await tenantQuery(tenantId,
      `INSERT INTO embeddings (tenant_id, source_type, source_id, metadata, vector)
       VALUES (app.current_tenant(), $1, $2, $3::jsonb, $4::vector)`,
      [s.type, String(s.id), JSON.stringify({ text: s.text }), `[${vec.join(',')}]`])
    indexed++
  }
  return { tenant: tenantId, indexed }
})

// RAG chat: embed query → cosine-similar retrieve tenant docs → grounded answer.
fastify.post('/chat', async (req, reply) => {
  const { message } = req.body || {}
  const tenantId = req.headers['x-tenant-id']
  if (!tenantId) return reply.code(400).send({ error: 'x-tenant-id required' })
  if (!message) return reply.code(400).send({ error: 'message required' })

  const vec = embed(message)
  const hits = await tenantQuery(tenantId,
    `SELECT source_type, source_id, metadata->>'text' AS text, 1 - (vector <=> $1::vector) AS score
     FROM embeddings
     ORDER BY vector <=> $1::vector
     LIMIT 4`, [`[${vec.join(',')}]`])

  if (!hits.rows.length) {
    return reply.send({
      reply: `No knowledge indexed for tenant "${tenantId}" yet — call POST /index first.`,
      sources: [],
    })
  }

  // Grounded extractive answer: return top contexts with scores. When an LLM key is
  // present this becomes a generateText({ prompt: context+question }) call instead.
  const top = hits.rows.filter((r) => r.score > 0)
  const lines = top.map((r, i) => `${i + 1}. [${r.source_type} ${r.source_id}] ${r.text}`)
  reply.send({
    reply: `Based on ${tenantId}'s data:\n${lines.join('\n')}`,
    sources: top.map((r) => ({ type: r.source_type, id: r.source_id, score: +r.score.toFixed(3) })),
  })
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
