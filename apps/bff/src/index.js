import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import pg from 'pg'
import fastifyStatic from '@fastify/static'
import multipart from '@fastify/multipart'
import { fileURLToPath } from 'url'
import path from 'path'
import * as XLSX from 'xlsx'

const fastify = Fastify({ logger: true })
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

await fastify.register(cors, { origin: true })
// Preview SPA uses inline event handlers (onclick=...), so allow them in CSP.
await fastify.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
})
await fastify.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } })

fastify.get('/health', async () => ({ ok: true, service: 'bff' }))

// Tenant-detection middleware.
// TODO: parse Directus JWT for real auth. For dev, x-tenant-id header selects the tenant.
fastify.addHook('preHandler', async (req) => {
  req.tenantId = req.headers['x-tenant-id'] || 'rubbertrack'
})

// Helper: run a query scoped to the request's tenant via RLS.
async function tenantQuery(req, text, params = []) {
  const client = await pool.connect()
  try {
    // is_local=false → session-level (persists across this connection's queries)
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [req.tenantId])
    return await client.query(text, params)
  } finally {
    // Clear so a pooled connection can't leak a tenant into the next request.
    await client.query("RESET app.tenant_id")
    client.release()
  }
}

// ---- Data endpoints (RLS-enforced) ----
fastify.get('/data/dashboard', async (req) => {
  const records = await tenantQuery(req, 'SELECT order_id, customer, supplier, grade, mt, fcl, price_usd, status FROM records ORDER BY created_at DESC LIMIT 4')
  const kpi = await tenantQuery(req, `SELECT
    (SELECT count(*) FROM records) AS open_orders,
    (SELECT coalesce(sum(mt),0) FROM records) AS active_mt,
    (SELECT count(*) FROM parties WHERE type='supplier') AS suppliers,
    (SELECT count(*) FROM parties WHERE type='customer') AS customers,
    (SELECT count(*) FROM tickets WHERE status<>'Resolved') AS open_issues`)
  const issues = await tenantQuery(req, `SELECT ticket_id, category, description, status FROM tickets WHERE status<>'Resolved' ORDER BY created_at DESC LIMIT 5`)
  const feed = await tenantQuery(req, `SELECT category, title, priority, published_at FROM feed_items ORDER BY published_at DESC LIMIT 8`)
  return { kpi: kpi.rows[0], orders: records.rows, issues: issues.rows, feed: feed.rows }
})

fastify.get('/data/orders', async (req) => {
  const r = await tenantQuery(req, 'SELECT order_id, customer, supplier, grade, mt, fcl, price_usd, status FROM records ORDER BY created_at DESC')
  return { orders: r.rows }
})

fastify.get('/data/issues', async (req) => {
  const r = await tenantQuery(req, 'SELECT ticket_id, category, description, status FROM tickets ORDER BY created_at DESC')
  const agg = await tenantQuery(req, 'SELECT category, count(*)::int AS value FROM tickets GROUP BY category')
  return { issues: r.rows, mix: agg.rows }
})

fastify.get('/data/parties', async (req) => {
  const sup = await tenantQuery(req, "SELECT name FROM parties WHERE type='supplier' ORDER BY name")
  const cus = await tenantQuery(req, "SELECT name FROM parties WHERE type='customer' ORDER BY name")
  return { suppliers: sup.rows.map(r => r.name), customers: cus.rows.map(r => r.name) }
})

fastify.get('/data/checklists', async (req) => {
  const r = await tenantQuery(req, 'SELECT checklist_json FROM checklists WHERE active=true ORDER BY id DESC LIMIT 1')
  return { items: r.rows[0]?.checklist_json || [] }
})

// ---- KPI engine (Phase 2a) — RLS-scoped aggregations for the chart builder ----
// Time-series of volume (MT) + revenue per month, driven by record.date.
fastify.get('/data/kpi/trend', async (req) => {
  const months = Math.min(parseInt(req.query.months || '6', 10), 24)
  const r = await tenantQuery(req, `
    SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month,
           coalesce(sum(mt),0)::float AS mt,
           coalesce(sum(mt * price_usd),0)::float AS revenue
    FROM records
    WHERE date >= date_trunc('month', current_date) - ($1 || ' months')::interval
    GROUP BY 1 ORDER BY 1`, [months])
  return { months: r.rows.map(x => x.month), mt: r.rows.map(x => x.mt), revenue: r.rows.map(x => x.revenue) }
})

// Volume by rubber grade.
fastify.get('/data/kpi/grades', async (req) => {
  const r = await tenantQuery(req, `
    SELECT grade, coalesce(sum(mt),0)::float AS mt, coalesce(sum(fcl),0)::int AS fcl
    FROM records GROUP BY grade ORDER BY mt DESC`)
  return { grades: r.rows }
})

// Issue mix by category + status breakdown.
fastify.get('/data/kpi/issues', async (req) => {
  const cat = await tenantQuery(req, 'SELECT category, count(*)::int AS value FROM tickets GROUP BY category ORDER BY value DESC')
  const status = await tenantQuery(req, 'SELECT status, count(*)::int AS value FROM tickets GROUP BY status ORDER BY value DESC')
  return { by_category: cat.rows, by_status: status.rows }
})

// Generic chart endpoint for the config-driven chart builder: any {dimension, metric}
// against records, so screen_configs charts need no new code.
fastify.get('/data/kpi/chart', async (req, reply) => {
  const DIMS = { grade: 'grade', customer: 'customer', supplier: 'supplier', status: 'status' }
  const METRICS = { mt: 'sum(mt)', fcl: 'sum(fcl)', count: 'count(*)', revenue: 'sum(mt*price_usd)' }
  const dim = DIMS[req.query.dimension]; const met = METRICS[req.query.metric]
  if (!dim || !met) return reply.code(400).send({ error: 'bad dimension/metric', dims: Object.keys(DIMS), metrics: Object.keys(METRICS) })
  const r = await tenantQuery(req, `SELECT ${dim} AS label, ${met}::float AS value FROM records GROUP BY 1 ORDER BY 2 DESC LIMIT 20`)
  return { dimension: req.query.dimension, metric: req.query.metric, labels: r.rows.map(x => x.label), values: r.rows.map(x => x.value) }
})

// ---- Hybrid search (Phase 2b) — tsvector keyword + pg_trgm fuzzy + pgvector semantic ----
// Keyword + fuzzy over records/parties/tickets/feed; semantic over embeddings when
// the caller passes ?embedding=[...] (ai-service supplies query vectors). All RLS-scoped.
fastify.get('/search', async (req) => {
  const q = (req.query.q || '').trim()
  if (!q) return { q, records: [], parties: [], tickets: [], feed: [], semantic: [] }
  const like = `%${q}%`
  const [records, parties, tickets, feed] = await Promise.all([
    tenantQuery(req, `
      SELECT order_id, customer, supplier, grade, mt, status,
        ts_rank(to_tsvector('english', coalesce(order_id,'')||' '||coalesce(customer,'')||' '||coalesce(supplier,'')||' '||coalesce(grade,'')), plainto_tsquery('english', $1)) AS rank
      FROM records
      WHERE to_tsvector('english', coalesce(order_id,'')||' '||coalesce(customer,'')||' '||coalesce(supplier,'')||' '||coalesce(grade,''))
            @@ plainto_tsquery('english', $1)
         OR customer ILIKE $2 OR supplier ILIKE $2 OR order_id ILIKE $2 OR grade ILIKE $2
      ORDER BY rank DESC LIMIT 10`, [q, like]),
    tenantQuery(req, `
      SELECT name, type, similarity(name, $1::text) AS sim
      FROM parties WHERE name ILIKE $2 OR similarity(name, $1::text) > 0.15
      ORDER BY sim DESC LIMIT 10`, [q, like]),
    tenantQuery(req, `
      SELECT ticket_id, category, status, left(description,120) AS snippet
      FROM tickets
      WHERE description ILIKE $1 OR category ILIKE $1 OR ticket_id ILIKE $1
      LIMIT 10`, [like]),
    tenantQuery(req, `
      SELECT category, title, priority
      FROM feed_items
      WHERE title ILIKE $1 OR description ILIKE $1 OR category ILIKE $1
      LIMIT 10`, [like]),
  ])
  // Optional semantic leg: if the client supplies a query embedding, rank the
  // tenant's embeddings by cosine distance. (Empty table → empty result, safe.)
  let semantic = []
  const emb = req.query.embedding
  if (emb) {
    try {
      const vec = JSON.parse(emb)
      const r = await tenantQuery(req, `
        SELECT source_type, source_id, left(metadata->>'text',200) AS snippet, 1 - (vector <=> $1::vector) AS score
        FROM embeddings ORDER BY vector <=> $1::vector LIMIT 5`, [`[${vec.join(',')}]`])
      semantic = r.rows
    } catch { semantic = [] }
  }
  return { q, records: records.rows, parties: parties.rows, tickets: tickets.rows, feed: feed.rows, semantic }
})

// ---- Excel/CSV import & export (tenant-scoped via RLS) ----
const IMPORTABLE = ['records', 'parties', 'tickets', 'feed_items']
const EXPORT_FIELDS = {
  records: ['order_id', 'date', 'customer', 'supplier', 'grade', 'mt', 'fcl', 'price_usd', 'status'],
  parties: ['name', 'type', 'contact', 'tags'],
  tickets: ['ticket_id', 'customer', 'supplier', 'category', 'status', 'description'],
  feed_items: ['category', 'title', 'description', 'priority', 'published_at'],
}

// Export a collection to xlsx. ?type=records|parties|tickets|feed_items
fastify.get('/data/export', async (req, reply) => {
  const type = (req.query.type || 'records')
  if (!IMPORTABLE.includes(type)) return reply.code(400).send({ error: 'unsupported type' })
  const fields = EXPORT_FIELDS[type]
  const r = await tenantQuery(req, `SELECT ${fields.join(',')} FROM ${type} ORDER BY created_at DESC`)
  const ws = XLSX.utils.json_to_sheet(r.rows.length ? r.rows : [{}])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, type)
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  reply.header('content-disposition', `attachment; filename="${type}-${req.tenantId}.xlsx"`)
  return buf
})

// Import xlsx/csv into a collection. Multipart upload: file + type.
fastify.post('/data/import', async (req, reply) => {
  const file = await req.file()
  if (!file) return reply.code(400).send({ error: 'no file' })
  const type = file.fields?.type?.value || 'records'
  if (!IMPORTABLE.includes(type)) return reply.code(400).send({ error: 'unsupported type' })
  const buf = await file.toBuffer()
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true })
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, dateNF: 'yyyy-mm-dd' })
  if (!rows.length) return { imported: 0 }
  const fields = EXPORT_FIELDS[type]
  // Build a parameterized multi-row INSERT (all tenant-scoped by RLS WITH CHECK).
  const cols = ['tenant_id', ...fields]
  let paramIdx = 1
  const values = []
  const placeholders = rows.map((row) => {
    const ph = cols.map(() => `$${paramIdx++}`).join(',')
    values.push(req.tenantId, ...fields.map((f) => row[f] ?? null))
    return `(${ph})`
  }).join(',')
  const sql = `INSERT INTO ${type} (${cols.join(',')}) VALUES ${placeholders}`
  await tenantQuery(req, sql, values)
  return { imported: rows.length, type }
})

// ---- Screen-config editor (per-tenant dashboard layout) ----
// Stores which charts/cards each screen shows so admins can reconfigure without code.
fastify.get('/data/screen-config', async (req) => {
  const screen = req.query.screen || 'dashboard'
  const r = await tenantQuery(req,
    'SELECT config FROM screen_configs WHERE active=true AND screen=$1 ORDER BY id DESC LIMIT 1', [screen])
  return { screen, config: r.rows[0]?.config || null }
})

fastify.put('/data/screen-config', async (req) => {
  const { screen = 'dashboard', config = {} } = req.body || {}
  // Deactivate old configs for this screen, then insert the new one (tenant-scoped).
  await tenantQuery(req, "UPDATE screen_configs SET active=false WHERE screen=$1", [screen])
  const r = await tenantQuery(req,
    "INSERT INTO screen_configs (tenant_id, screen, config, active) VALUES ($1,$2,$3,true) RETURNING id",
    [req.tenantId, screen, JSON.stringify(config)])
  return { id: r.rows[0]?.id, screen, saved: true }
})

// Proxy to AI service (approve the AI contexts)
fastify.post('/ai/chat', async (req, reply) => {
  const res = await fetch(`${AI_SERVICE_URL}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': req.tenantId },
    body: JSON.stringify(req.body)
  })
  reply.send(await res.text())
})

// Reindex the tenant's knowledge base (records/tickets/parties → embeddings).
fastify.post('/ai/reindex', async (req, reply) => {
  const res = await fetch(`${AI_SERVICE_URL}/index`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': req.tenantId },
    body: '{}'
  })
  reply.send(await res.text())
})

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
