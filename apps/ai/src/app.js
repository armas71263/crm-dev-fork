import Fastify from 'fastify'
import crypto from 'crypto'
import { streamText, generateText, tool as sdkTool, jsonSchema, stepCountIs } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

const DIM = 768

const PROVIDERS = {
  local: { name: 'local', model: 'deterministic-hash-v1' },
  openrouter: { name: 'openrouter', model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet', keyEnv: 'OPENROUTER_API_KEY' },
  nim: { name: 'nim', model: process.env.NIM_MODEL || 'meta/llama-3.1-70b', keyEnv: 'NIM_API_KEY' },
  openai: { name: 'openai', model: process.env.OPENAI_MODEL || 'gpt-4o-mini', keyEnv: 'OPENAI_API_KEY' },
  ollama: { name: 'ollama', model: process.env.OLLAMA_MODEL || 'llama3.1', keyEnv: null },
  cloudflare: { name: 'cloudflare', model: process.env.CLOUDFLARE_LLM_MODEL || '@cf/qwen/qwen3.8-27b', keyEnv: 'CLOUDFLARE_API_TOKEN' },
}

// A tenant's provider is chosen by env (default "local"). Real providers
// (openrouter/nim/openai/ollama) light up when their API key is present; until
// then the deterministic local provider runs so the whole platform works offline.
export function pickProvider(tenantId) {
  const requested = process.env.AI_PROVIDER || 'local'
  const p = PROVIDERS[requested] || PROVIDERS.local
  // Real providers need a key (ollama needs a reachable host); else fall back.
  if (p.keyEnv && !process.env[p.keyEnv]) return PROVIDERS.local
  if (p.name === 'cloudflare' && !process.env.CLOUDFLARE_ACCOUNT_ID) return PROVIDERS.local
  return { ...p, tenantId }
}

// SDK model factory (AI SDK v5). Cloudflare Workers AI is served through its
// OpenAI-compatible endpoint, routed via the AI Gateway (default gateway) with
// each request tagged by tenant for gateway analytics; OpenRouter works through
// the same interface.
function makeSdkModel(provider) {
  if (provider.name === 'cloudflare') {
    const cf = createOpenAICompatible({
      name: 'cloudflare',
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
      apiKey: process.env.CLOUDFLARE_API_TOKEN,
      headers: {
        'cf-aig-gateway-id': process.env.CLOUDFLARE_AI_GATEWAY_ID || 'default',
        'cf-aig-metadata': JSON.stringify({ tenant: provider.tenantId }),
      },
    })
    return cf(provider.model)
  }
  if (provider.name === 'openrouter') {
    const or = createOpenAICompatible({ name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY })
    return or(provider.model)
  }
  return null
}

// Real embeddings via Cloudflare Workers AI (bge-base-en-v1.5, 768-d) through
// the AI Gateway. Batch-capable; callers fall back to the hash embedder.
export async function realEmbed(texts) {
  const token = process.env.CLOUDFLARE_API_TOKEN
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!token || !account) return null
  const model = process.env.CLOUDFLARE_EMBED_MODEL || '@cf/baai/bge-base-en-v1.5'
  const wasArray = Array.isArray(texts)
  const input = (wasArray ? texts : [texts]).map((t) => String(t).slice(0, 1200))
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'cf-aig-gateway-id': process.env.CLOUDFLARE_AI_GATEWAY_ID || 'default',
    },
    body: JSON.stringify({ text: input }),
  })
  if (!res.ok) throw new Error(`cloudflare embed ${res.status}: ${(await res.text()).slice(0, 120)}`)
  const body = await res.json()
  const data = body.result?.data || body.data
  if (!Array.isArray(data) || !data.length || !Array.isArray(data[0]) || data[0].length !== 768) {
    throw new Error('unexpected embedding shape from cloudflare')
  }
  return wasArray ? data : data[0]
}

// Query embedding for semantic retrieval: real model when configured,
// deterministic hash embedder otherwise.
async function embedQuery(text) {
  try {
    const real = await realEmbed(text)
    if (real) return real
  } catch { /* fall through to the hash embedder */ }
  return embed(text)
}

// Deterministic local embedding (hashing trick, L2-normalized).
export function embed(text) {
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

export function makeTenantQuery(pool) {
  return async function tenantQuery(tenantId, text, params = []) {
    const client = await pool.connect()
    try {
      await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId])
      return await client.query(text, params)
    } finally {
      try { await client.query('RESET app.tenant_id') } catch { /* connection gone — nothing to reset */ }
      client.release()
    }
  }
}



// Chart intent detection — keywords that signal a visualization request.
// Multi-turn: if the message has a filter ("now just TSR-20") but no chart
// keywords, and the session has a previous chart, treat it as a refinement.
export function detectChartIntent(message, session = null) {
  const m = message.toLowerCase()
  const hasIntent = /(chart|graph|plot|visuali[sz]e|trend|over time|by \w+|compare|breakdown|top \d+|rank|show me.*(by|per|over))/i.test(m)
  // Extract filter first — a bare filter with a prior chart = refine the prior chart.
  const fm = m.match(/(?:for|only|just|just the|show only|now just|now only|filter to)\s+([a-z0-9 -]{2,30})/i)
  const filter = fm ? fm[1].trim() : null
  if (!hasIntent) {
    if (filter && session?.lastChart) return { ...session.lastChart, filter }
    return null
  }
  let dimension = null, metric = 'count'
  if (/by grade|grade.*(breakdown|chart)|per grade/i.test(m)) dimension = 'grade'
  else if (/by supplier|per supplier|supplier.*(breakdown|chart)/i.test(m)) dimension = 'supplier'
  else if (/by status|per status|status.*(breakdown|chart)/i.test(m)) dimension = 'status'
  else if (/by category|per category|category.*(breakdown|chart)/i.test(m)) dimension = 'category'
  else if (/over time|by month|per month|monthly|trend/i.test(m)) dimension = 'month'
  else if (/by type|per type|type.*(breakdown|chart)/i.test(m)) dimension = 'type'
  else if (/by stage|stage.*(breakdown|chart)|pipeline.*(breakdown|chart)|by pipeline/i.test(m)) dimension = 'stage'
  else if (/by compan(y|ies)|per company|account.*(breakdown|chart)|by account/i.test(m)) dimension = 'company'
  else if (/by source|per source|source.*(breakdown|chart)/i.test(m)) dimension = 'source'
  if (/mt|volume|tonnage/i.test(m)) metric = 'mt'
  else if (/revenue|value|sales|money|\$/i.test(m)) metric = 'revenue'
  else if (/fcl|container/i.test(m)) metric = 'fcl'
  return { dimension: dimension || session?.lastChart?.dimension || 'customer', metric, filter }
}

// Planner: keyword route the message to the right tool(s) — works with the local
// provider. With a real provider this is an LLM tool-call loop.
// CRM tools cover the generic schema (companies/contacts/leads/deals/activities)
// and always run; the rubber-vertical tools run only for tenants that actually
// hold vertical rows (`vertical` flag, set by the routes via hasVerticalData).
const CRM_WORDS = /(deal|pipeline|lead|compan(y|ies)|contact|account|task|activit|meeting|note|call|prospect)/
const CRM_OVERVIEW = /(overview|summary|how many|count|kpi|status|total|metric|pipeline|dashboard)/
export function plan(message, { crm = true, vertical = true } = {}) {
  const m = message.toLowerCase()
  const calls = []
  // Text-to-SQL: an explicit sql ask, or a message that IS a SELECT/WITH.
  if (/\bsql\b/i.test(m) || /^\s*(select|with)\b/i.test(message)) {
    calls.push({ name: 'run_sql', args: { q: message } })
  }
  // Forecasts: any predict/forecast ask reads the stored prediction.
  if (/(forecast|predict|next few months|upcoming volume)/.test(m)) {
    calls.push({ name: 'get_forecast', args: { series: /deal|pipeline value|revenue/.test(m) ? 'deal_value' : 'record_mt' } })
  }
  if (crm) {
    if (CRM_WORDS.test(m)) calls.push({ name: 'search_crm', args: { q: message } })
    if (CRM_OVERVIEW.test(m)) calls.push({ name: 'get_crm_kpi', args: {} })
  }
  if (vertical) {
    if (/(issue|quality|problem|defect|moisture|spec|document|shipment)/.test(m)) calls.push({ name: 'get_issues', args: {} })
    if (/(order|buy|sell|tsr|rss|latex|grade|mt|ton|ship|deliver|customer|supplier)/.test(m)) calls.push({ name: 'search_records', args: { q: message } })
    if (/(party|supplier|customer|contact|who|name)/.test(m)) calls.push({ name: 'get_party', args: { q: message } })
    if (CRM_OVERVIEW.test(m)) calls.push({ name: 'get_kpi', args: {} })
  }
  if (!calls.length) calls.push(crm ? { name: 'get_crm_kpi', args: {} } : { name: 'get_kpi', args: {} })
  return calls
}

// Dimensions only the CRM chart tool can answer; everything else falls to the
// vertical suggest_chart. Used by the chat routes to pick the chart tool.
export const CRM_CHART_DIMS = new Set(['stage', 'company', 'source'])

// ---- Text-to-SQL guardrails (Phase 4) ----
// Single read-only statement. The app_readonly role (SELECT-only grants),
// tenant-isolation RLS and the statement timeout are the real walls — this
// validation is defense in depth, and it makes bad queries fail fast.
const SQL_FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|grant|revoke|copy|create|call|do|vacuum|listen|notify|lock|set|reset|begin|commit|rollback|execute)\b/i
export function validateSql(sql) {
  const t = String(sql || '').trim().replace(/;+\s*$/, '')
  if (!t) return { error: 'empty query' }
  if (t.includes(';')) return { error: 'only a single statement is allowed' }
  if (!/^(select|with)\b/i.test(t)) return { error: 'only SELECT (or WITH ... SELECT) queries are allowed' }
  if (SQL_FORBIDDEN.test(t)) return { error: 'read-only queries only — forbidden keyword detected' }
  return { sql: t }
}

// Pull an embedded SELECT out of a natural-language request ("sql: SELECT ...").
export function extractSql(text) {
  const m = String(text || '').match(/((?:select|with)\b[^;]*)/i)
  return m ? m[1].trim() : String(text || '')
}

export async function buildApp({ pool, readonlyPool, logger = true }) {
  const fastify = Fastify({ logger })
  const tenantQuery = makeTenantQuery(pool)

  // ---- Conversation memory (Phase 4): turns persist in Postgres, RLS-scoped
  // ---- per tenant. A DB hiccup degrades to no-history — chat never breaks.
  async function loadMemory(tenantId, sessionKey) {
    const key = sessionKey || 'default'
    try {
      const r = await tenantQuery(tenantId,
        `SELECT m.role, m.content, m.chart FROM ai_chat_messages m
         JOIN ai_chat_sessions s ON s.id = m.session_id
         WHERE s.session_key = $1 ORDER BY m.id DESC LIMIT 10`, [key])
      const rows = r.rows.reverse()
      const lastChart = [...rows].reverse().find((x) => x.chart)?.chart || null
      return { history: rows.map((x) => ({ role: x.role, text: x.content })), lastChart }
    } catch (e) {
      fastify.log.warn({ err: e.message }, 'chat memory unavailable — continuing without history')
      return { history: [], lastChart: null }
    }
  }

  async function saveTurn(tenantId, sessionKey, { userText, assistantText, tools, chart }) {
    const key = sessionKey || 'default'
    try {
      const s = await tenantQuery(tenantId,
        `INSERT INTO ai_chat_sessions (tenant_id, session_key) VALUES (app.current_tenant(), $1)
         ON CONFLICT (tenant_id, session_key) DO UPDATE SET updated_at = now() RETURNING id`, [key])
      const sid = s.rows[0]?.id
      if (!sid) return
      await tenantQuery(tenantId,
        `INSERT INTO ai_chat_messages (tenant_id, session_id, role, content, tools, chart)
         VALUES (app.current_tenant(), $1, 'user', $2, '[]'::jsonb, NULL)`, [sid, userText])
      await tenantQuery(tenantId,
        `INSERT INTO ai_chat_messages (tenant_id, session_id, role, content, tools, chart)
         VALUES (app.current_tenant(), $1, 'assistant', $2, $3::jsonb, $4::jsonb)`,
        [sid, assistantText, JSON.stringify(tools || []), chart ? JSON.stringify(chart) : null])
    } catch (e) {
      fastify.log.warn({ err: e.message }, 'chat memory save failed — turn not persisted')
    }
  }

  // ---- Text-to-SQL execution: app_readonly pool, transaction-local tenant
  // ---- GUC + statement timeout. Any error fails closed with a message.
  async function runReadonly(tenantId, sql) {
    if (!readonlyPool) return { error: 'text-to-SQL is not configured (no readonly pool)' }
    const client = await readonlyPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
      await client.query("SET LOCAL statement_timeout = '5s'")
      const r = await client.query(sql)
      await client.query('COMMIT')
      return { rows: r.rows.slice(0, 50), rowCount: r.rowCount }
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* already aborted */ }
      return { error: `query failed: ${e.message.slice(0, 160)}` }
    } finally {
      client.release()
    }
  }

  // Vertical (rubber-trading) data is template-specific; the CRM schema is
  // universal. Vertical tools run only for tenants whose vertical tables
  // actually hold rows — an RLS-scoped presence probe, cached briefly.
  const VERTICAL_CACHE = new Map()
  const hasVerticalData = async (tenantId) => {
    const hit = VERTICAL_CACHE.get(tenantId)
    if (hit && Date.now() - hit.ts < 60000) return hit.has
    let has = false
    try { has = (await tenantQuery(tenantId, 'SELECT 1 FROM records LIMIT 1')).rows.length > 0 } catch { has = false }
    VERTICAL_CACHE.set(tenantId, { ts: Date.now(), has })
    return has
  }

  // Usage logging — every AI call is accounted per tenant. Failures are logged
  // and swallowed so an accounting hiccup never breaks a chat reply.
  async function logUsage(tenantId, { requestId, provider, model, tool, tokensIn = 0, tokensOut = 0, costUsd = 0, latencyMs = 0 }) {
    try {
      await tenantQuery(tenantId,
        `INSERT INTO ai_usage_logs (tenant_id, request_id, provider, model, tool, tokens_in, tokens_out, cost_usd, latency_ms)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8)`,
        [requestId, provider, model, tool, tokensIn, tokensOut, costUsd, latencyMs])
    } catch (e) { fastify.log.warn({ msg: 'usage log failed', err: e.message }) }
  }

  fastify.get('/health', async () => ({ ok: true, service: 'ai' }))

  // ---- Agent tools — each returns tenant-scoped structured data ----
  const TOOLS = {
    search_records: async (tenantId, { q }) => {
      const like = `%${q}%`
      const r = await tenantQuery(tenantId,
        `SELECT order_id, customer, supplier, grade, mt, fcl, price_usd, status FROM records
         WHERE customer ILIKE $1 OR supplier ILIKE $1 OR order_id ILIKE $1 OR grade ILIKE $1
         ORDER BY created_at DESC LIMIT 5`, [like])
      return r.rows
    },
    get_kpi: async (tenantId) => {
      const r = await tenantQuery(tenantId, `SELECT
        count(*)::int AS open_orders, coalesce(sum(mt),0)::float AS active_mt,
        count(DISTINCT supplier)::int AS suppliers, count(DISTINCT customer)::int AS customers
        FROM records`)
      return r.rows[0]
    },
    get_issues: async (tenantId) => {
      const r = await tenantQuery(tenantId, `SELECT ticket_id, category, status, description FROM tickets WHERE status<>'Resolved' ORDER BY created_at DESC LIMIT 5`)
      return r.rows
    },
    get_party: async (tenantId, { q }) => {
      const r = await tenantQuery(tenantId, `SELECT name, type, contact FROM parties WHERE name ILIKE $1 LIMIT 5`, [`%${q}%`])
      return r.rows
    },
    // suggest_chart: aggregates the data and returns a chart spec the UI renders inline.
    suggest_chart: async (tenantId, { dimension, metric = 'count', title, filter }) => {
      // Dimension-to-table map: category lives on tickets, not records.
      const SPECS = {
        grade: { from: 'records', dim: 'grade' },
        customer: { from: 'records', dim: 'customer' },
        supplier: { from: 'records', dim: 'supplier' },
        status: { from: 'records', dim: 'status' },
        category: { from: 'tickets', dim: 'category' },
        month: { from: 'records', dim: "to_char(date_trunc('month', date), 'YYYY-MM')" },
      }
      const METRICS = { mt: 'sum(mt)', fcl: 'sum(fcl)', count: 'count(*)', revenue: 'sum(mt*price_usd)', avg_price: 'avg(price_usd)' }
      const spec = SPECS[dimension] || SPECS.customer
      const met = METRICS[metric] || METRICS.count
      let where = '', params = []
      if (filter && spec.from === 'records') { where = 'WHERE grade ILIKE $1 OR customer ILIKE $1 OR supplier ILIKE $1'; params = [`%${filter}%`] }
      const r = await tenantQuery(tenantId,
        `SELECT ${spec.dim} AS label, ${met}::float AS value FROM ${spec.from} ${where} GROUP BY 1 ORDER BY ${dimension === 'month' ? '1 ASC' : '2 DESC'} LIMIT 20`, params)
      return { chart: { type: dimension === 'month' ? 'line' : 'bar', title: title || `${metric} by ${dimension}`, labels: r.rows.map(x => x.label), values: r.rows.map(x => x.value) } }
    },

    // ---- Generic CRM tools (companies/contacts/leads/deals/activities) ----
    search_crm: async (tenantId, { q }) => {
      const like = `%${q}%`
      const r = await tenantQuery(tenantId, `
        SELECT * FROM (
          (SELECT 'company' AS kind, name::text AS label, coalesce(type,'') AS detail FROM companies WHERE name ILIKE $1 OR coalesce(industry,'') ILIKE $1 LIMIT 3)
          UNION ALL (SELECT 'contact', full_name, coalesce(title,'') FROM contacts WHERE full_name ILIKE $1 OR coalesce(email,'') ILIKE $1 LIMIT 3)
          UNION ALL (SELECT 'lead', name, coalesce(company_name,'') FROM leads WHERE name ILIKE $1 OR coalesce(company_name,'') ILIKE $1 LIMIT 3)
          UNION ALL (SELECT 'deal', name, coalesce(stage,'') FROM deals WHERE name ILIKE $1 LIMIT 3)
          UNION ALL (SELECT 'activity', subject, coalesce(type,'') FROM activities WHERE subject ILIKE $1 OR coalesce(detail,'') ILIKE $1 LIMIT 3)
        ) sub LIMIT 9`, [like])
      return r.rows
    },
    get_crm_kpi: async (tenantId) => {
      const r = await tenantQuery(tenantId, `SELECT
        (SELECT count(*) FROM companies)::int AS companies,
        (SELECT count(*) FROM contacts)::int AS contacts,
        (SELECT count(*) FROM leads WHERE status NOT IN ('won','lost','converted','disqualified','closed'))::int AS open_leads,
        (SELECT count(*) FROM deals WHERE status='open')::int AS open_deals,
        (SELECT coalesce(sum(value),0) FROM deals WHERE status='open')::float AS pipeline_value,
        (SELECT count(*) FROM activities WHERE type='task' AND NOT completed)::int AS open_tasks,
        (SELECT count(*) FROM activities WHERE type='task' AND NOT completed AND due_at < now())::int AS overdue_tasks`)
      return r.rows[0]
    },
    // suggest_crm_chart: aggregates the generic CRM and returns a chart spec.
    suggest_crm_chart: async (tenantId, { dimension, metric = 'count', title, filter }) => {
      const SPECS = {
        stage: { from: 'deals', dim: 'stage' },
        company: { from: 'deals d JOIN companies c ON c.id = d.company_id', dim: 'c.name' },
        source: { from: 'leads', dim: `coalesce(source,'n/a')` },
        status: { from: 'leads', dim: 'status' },
        type: { from: 'activities', dim: 'type' },
        month: { from: 'deals', dim: "to_char(date_trunc('month', coalesce(expected_close_date, created_at)), 'YYYY-MM')" },
      }
      const spec = SPECS[dimension] || SPECS.stage
      const met = metric === 'value' || metric === 'revenue' ? 'sum(value)' : metric === 'avg_value' || metric === 'avg_price' ? 'avg(value)' : 'count(*)'
      let where = '', params = []
      if (filter) { where = `WHERE ${spec.dim} ILIKE $1`; params = [`%${filter}%`] }
      const r = await tenantQuery(tenantId,
        `SELECT ${spec.dim} AS label, ${met}::float AS value FROM ${spec.from} ${where} GROUP BY 1 ORDER BY ${dimension === 'month' ? '1 ASC' : '2 DESC'} LIMIT 20`, params)
      return { chart: { type: dimension === 'month' ? 'line' : 'bar', title: title || `${metric} by ${dimension}`, labels: r.rows.map(x => x.label), values: r.rows.map(x => x.value) } }
    },

    // get_forecast: reads the tenant's stored forecast (predictions table).
    get_forecast: async (tenantId, { series = 'record_mt' }) => {
      const r = await tenantQuery(tenantId,
        'SELECT series, model, horizon, history, forecast, generated_at FROM predictions WHERE series = $1', [series])
      if (!r.rows.length) return { error: 'no stored forecast for this series - generate one from the Dashboard forecast panel first' }
      return r.rows[0]
    },

    // run_sql: LLM- or user-written SELECT, executed behind the guardrails.
    run_sql: async (tenantId, { q, sql }) => {
      const check = validateSql(sql || extractSql(q))
      if (check.error) return { error: check.error }
      return runReadonly(tenantId, check.sql)
    },
  }

  // SDK tool definitions: the model plans and calls these (AI SDK v5);
  // execution stays in TOOLS — same tenant-scoped implementations, same
  // guardrails (run_sql validates before it ever touches the readonly pool).
  function sdkTools(tid) {
    const defs = {
      search_crm: {
        d: 'Search the CRM — companies, contacts, leads, deals, activities — by keyword.',
        s: { type: 'object', properties: { q: { type: 'string', description: 'keyword' } }, required: ['q'] },
      },
      get_crm_kpi: {
        d: 'CRM KPIs: companies, contacts, open leads, open deals, pipeline value, open tasks. Use for overview and how-many questions.',
        s: { type: 'object', properties: {} },
      },
      search_records: {
        d: 'Search rubber-trading order records by keyword (order id, customer, supplier, grade).',
        s: { type: 'object', properties: { q: { type: 'string', description: 'keyword' } }, required: ['q'] },
      },
      get_kpi: {
        d: 'Trading KPIs: open orders, active MT, suppliers, customers.',
        s: { type: 'object', properties: {} },
      },
      get_issues: {
        d: 'Recent open quality tickets.',
        s: { type: 'object', properties: {} },
      },
      get_party: {
        d: 'Look up suppliers and customers by name.',
        s: { type: 'object', properties: { q: { type: 'string', description: 'party name' } }, required: ['q'] },
      },
      get_forecast: {
        d: 'Read the stored forecast for a time series (record_mt = monthly order volume forecast, deal_value = monthly deal value forecast). Includes history and the predicted next months.',
        s: { type: 'object', properties: { series: { type: 'string', description: 'series key: record_mt or deal_value' } } },
      },
      run_sql: {
        d: 'Run a read-only SQL query (a single SELECT or WITH...SELECT statement only) against the tenant database, for questions the other tools cannot answer.',
        s: { type: 'object', properties: { sql: { type: 'string', description: 'the SELECT statement to run' } }, required: ['sql'] },
      },
    }
    const out = {}
    for (const [name, { d, s }] of Object.entries(defs)) {
      out[name] = sdkTool({ description: d, inputSchema: jsonSchema(s), execute: (args) => TOOLS[name](tid, args) })
    }
    return out
  }

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

    // Generic CRM entities — indexed for every tenant (the product's core data).
    const crmSources = await Promise.all([
      tenantQuery(tenantId, `SELECT name AS id, 'company' AS type,
              'Company '||name||' ('||type||coalesce(', '||industry,'')||')' AS text FROM companies`),
      tenantQuery(tenantId, `SELECT full_name AS id, 'contact' AS type,
              'Contact '||full_name||coalesce(', '||title,'') AS text FROM contacts`),
      tenantQuery(tenantId, `SELECT name AS id, 'lead' AS type,
              'Lead '||name||' for '||coalesce(company_name,'n/a')||' worth $'||coalesce(value,0) AS text FROM leads`),
      tenantQuery(tenantId, `SELECT name AS id, 'deal' AS type,
              'Deal '||name||' at stage '||stage||' worth $'||coalesce(value,0) AS text FROM deals`),
      tenantQuery(tenantId, `SELECT subject AS id, 'activity' AS type,
              initcap(type)||': '||subject||coalesce(' — '||left(detail,120),'') AS text FROM activities`),
    ])
    for (const q of crmSources) sources.push(...q.rows)

    await tenantQuery(tenantId, 'DELETE FROM embeddings')
    let indexed = 0
    // Real embeddings (bge-base 768-d) when configured — one batched call;
    // deterministic hash embedder otherwise.
    let vectors = null
    try { vectors = await realEmbed(sources.map((s) => s.text)) }
    catch (e) { fastify.log.warn({ err: e.message }, 'real embeddings unavailable — hash fallback') }
    for (const [i, s] of sources.entries()) {
      const vec = vectors ? vectors[i] : embed(s.text)
      await tenantQuery(tenantId,
        `INSERT INTO embeddings (tenant_id, source_type, source_id, metadata, vector)
         VALUES (app.current_tenant(), $1, $2, $3::jsonb, $4::vector)`,
        [s.type, String(s.id), JSON.stringify({ text: s.text }), `[${vec.join(',')}]`])
      indexed++
    }
    return { tenant: tenantId, indexed }
  })

  // Agentic RAG chat: plan → tools → retrieve → synthesize, logged.
  fastify.post('/chat', async (req, reply) => {
    const { message, session_id } = req.body || {}
    const tenantId = req.headers['x-tenant-id']
    if (!tenantId) return reply.code(400).send({ error: 'x-tenant-id required' })
    if (!message) return reply.code(400).send({ error: 'message required' })

    const t0 = Date.now()
    const requestId = crypto.randomUUID()
    const provider = pickProvider(tenantId)
    const mem = await loadMemory(tenantId, session_id)

    // 1) Plan which tools to run. The local provider uses the keyword planner;
    // real providers run the SDK agent loop below (the model picks tools).
    const vertical = await hasVerticalData(tenantId)
    const toolCalls = provider.name === 'local' ? plan(message, { vertical }) : []
    const observations = []
    for (const tc of toolCalls) {
      const obs = await TOOLS[tc.name](tenantId, tc.args)
      observations.push({ tool: tc.name, result: obs })
    }

    // 2) Chart intent — detect visualization requests and build a chart spec.
    const chartIntent = detectChartIntent(message, mem)
    let chart = null
    if (chartIntent) {
      // Multi-turn: carry a previous chart's filter/dimension when unset.
      if (!chartIntent.filter && mem.lastChart?.filter) chartIntent.filter = mem.lastChart.filter
      if (!chartIntent.dimension && mem.lastChart?.dimension) chartIntent.dimension = mem.lastChart.dimension
      const chartTool = (CRM_CHART_DIMS.has(chartIntent.dimension) || !vertical) ? 'suggest_crm_chart' : 'suggest_chart'
      try {
        const res = await TOOLS[chartTool](tenantId, chartIntent)
        chart = res.chart
        observations.push({ tool: chartTool, result: chart })
      } catch (e) {
        fastify.log.warn({ err: e.message }, 'chart tool failed — continuing without a chart')
        chart = null
      }
    }

    // 3) Semantic retrieval from the knowledge base (local path — the SDK
    //    agent retrieves via tools). Real embeddings when configured.
    let semantic = []
    if (provider.name === 'local') {
      const vec = await embedQuery(message)
      const hits = await tenantQuery(tenantId,
        `SELECT source_type, source_id, metadata->>'text' AS text, 1 - (vector <=> $1::vector) AS score
         FROM embeddings ORDER BY vector <=> $1::vector LIMIT 4`, [`[${vec.join(',')}]`])
      semantic = hits.rows.filter((r) => r.score > 0)
    }

    // 4) Synthesize. Real provider calls OpenRouter with the gathered context;
    //    local provider = extractive grounded answer.
    let replyText, tokensIn = message.length, tokensOut = 0, costUsd = 0
    let toolNames = observations.map((o) => o.tool)
    const lines = []
    for (const o of observations) {
      if (o.tool === 'search_records' && o.result.length) {
        lines.push(...o.result.map((r) => `• ${r.order_id}: ${r.customer} ${r.grade} ${r.mt}MT from ${r.supplier} (${r.status})`))
      } else if (o.tool === 'search_crm' && o.result.length) {
        lines.push(...o.result.map((r) => `• ${r.kind}: ${r.label}${r.detail ? ' — ' + r.detail : ''}`))
      } else if (o.tool === 'get_crm_kpi' && o.result) {
        lines.push(`• CRM: ${o.result.companies} companies, ${o.result.contacts} contacts, ${o.result.open_leads} open leads, ${o.result.open_deals} open deals ($${Math.round(o.result.pipeline_value).toLocaleString('en-US')} pipeline), ${o.result.open_tasks} open tasks (${o.result.overdue_tasks} overdue)`)
      } else if (o.tool === 'get_kpi' && o.result) {
        lines.push(`• KPIs: ${o.result.open_orders} open orders, ${o.result.active_mt} active MT, ${o.result.suppliers} suppliers, ${o.result.customers} customers`)
      } else if (o.tool === 'get_issues' && o.result.length) {
        lines.push(...o.result.map((i) => `• ${i.ticket_id} [${i.category}] ${i.description} (${i.status})`))
      } else if (o.tool === 'get_party' && o.result.length) {
        lines.push(...o.result.map((p) => `• ${p.name} (${p.type})`))
      } else if (o.tool === 'run_sql' && o.result) {
        if (o.result.error) lines.push(`• SQL tool: ${o.result.error}`)
        else if (o.result.rows?.length) lines.push(`• SQL result (${o.result.rowCount} rows): ${JSON.stringify(o.result.rows.slice(0, 5)).slice(0, 400)}`)
        else lines.push('• SQL result: no rows')
      } else if (o.tool.startsWith('suggest_') && o.result?.labels?.length) {
        lines.push(`• Chart ready: ${o.result.title} (${o.result.labels.length} bars) — rendered below.`)
      }
    }
    for (const s of semantic) lines.push(`• [${s.source_type} ${s.source_id}] ${s.text}`)
    const context = lines.join('\n')

    // 5) Multi-turn: include recent turns in the LLM prompt.
    const history = mem.history.slice(-4).map((t) => `${t.role}: ${t.text}`).join('\n')

    if (provider.name !== 'local') {
      // SDK agent path (AI SDK v5): the model plans and calls tools itself,
      // grounded in the tenant's data; conversation memory rides along.
      try {
        const result = await generateText({
          model: makeSdkModel(provider),
          system: `You are a B2B CRM + operations assistant for tenant "${tenantId}". Answer grounded in the tenant's data using the provided tools. Be concise and specific. Prefer the dedicated search/KPI tools; only use run_sql for questions they cannot answer (a single read-only SELECT). Once you have relevant results, answer immediately — do not repeat similar tool calls. If the tools don't contain the answer, say so.`,
          messages: [...mem.history.slice(-8).map((t) => ({ role: t.role, content: t.text })), { role: 'user', content: message }],
          tools: sdkTools(tenantId),
          stopWhen: stepCountIs(8),
        })
        replyText = result.text || ''
        toolNames = [...toolNames, ...result.toolCalls.map((c) => c.toolName)]
        tokensIn = result.usage.inputTokens || 0
        tokensOut = result.usage.outputTokens || 0
        if (!replyText.trim()) {
          // Step budget exhausted before a final answer — synthesize one from
          // the tool observations so the user never gets silence.
          const obsLines = (result.toolResults || []).map((r) => `${r.toolName}: ${JSON.stringify(r.result).slice(0, 300)}`)
          replyText = obsLines.length ? `Based on ${tenantId}'s data (tools: ${toolNames.join(', ')}):\n${obsLines.join('\n')}` : `I couldn't find anything relevant for "${message}".`
        }
      } catch (e) {
        fastify.log.warn({ msg: 'LLM call failed, falling back', err: e.message })
        replyText = context ? `Based on ${tenantId}'s data (tools: ${toolNames.join(', ')}):\n${context}` : `I couldn't find anything relevant for "${message}".`
      }
    } else {
      replyText = context
        ? `Based on ${tenantId}'s data (tools: ${toolNames.join(', ')}):\n${context}`
        : `I couldn't find anything relevant for "${message}". Try asking about orders, issues, or suppliers.`
      tokensOut = replyText.length
    }

    const latency = Date.now() - t0
    await logUsage(tenantId, { requestId, provider: provider.name, model: provider.model, tool: toolNames.join(',') || 'planner', tokensIn, tokensOut, costUsd, latencyMs: latency })

    // 6) Persist the turn (Phase 4 conversation memory).
    await saveTurn(tenantId, session_id, { userText: message, assistantText: replyText, tools: toolNames, chart: chart ? { ...chartIntent, spec: chart } : null })

    reply.send({
      reply: replyText,
      chart,
      tools: toolNames,
      sources: semantic.map((r) => ({ type: r.source_type, id: r.source_id, score: +r.score.toFixed(3) })),
      usage: { provider: provider.name, model: provider.model, latency_ms: latency, request_id: requestId, tokens_in: tokensIn, tokens_out: tokensOut },
    })
  })

  // ---- Streaming chat (SSE) ----
  fastify.post('/chat/stream', async (req, reply) => {
    const { message, session_id } = req.body || {}
    const tenantId = req.headers['x-tenant-id']
    if (!tenantId || !message) return reply.code(400).send({ error: 'x-tenant-id and message required' })

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    const t0 = Date.now()
    const requestId = crypto.randomUUID()
    const provider = pickProvider(tenantId)
    const mem = await loadMemory(tenantId, session_id)

    send('start', { request_id: requestId, provider: provider.name })

    // Plan + run tools, streaming each tool observation as it completes.
    // The local provider uses the keyword planner; real providers stream the
    // SDK agent loop below (model-driven tool calls).
    const vertical = await hasVerticalData(tenantId)
    const toolCalls = provider.name === 'local' ? plan(message, { vertical }) : []
    const observations = []
    for (const tc of toolCalls) {
      send('tool', { name: tc.name })
      const obs = await TOOLS[tc.name](tenantId, tc.args)
      observations.push({ tool: tc.name, result: obs })
      send('observation', { tool: tc.name, count: Array.isArray(obs) ? obs.length : 1 })
    }

    // Chart intent — detect and stream a chart spec inline.
    const chartIntent = detectChartIntent(message, mem)
    let chart = null
    if (chartIntent) {
      if (!chartIntent.filter && mem.lastChart?.filter) chartIntent.filter = mem.lastChart.filter
      if (!chartIntent.dimension && mem.lastChart?.dimension) chartIntent.dimension = mem.lastChart.dimension
      const chartTool = (CRM_CHART_DIMS.has(chartIntent.dimension) || !vertical) ? 'suggest_crm_chart' : 'suggest_chart'
      try {
        send('tool', { name: chartTool })
        const res = await TOOLS[chartTool](tenantId, chartIntent)
        chart = res.chart
        send('chart', chart)
      } catch (e) {
        fastify.log.warn({ err: e.message }, 'chart tool failed — continuing without a chart')
        chart = null
      }
    }

    // Semantic retrieval (local path — the SDK agent retrieves via tools).
    let semantic = []
    if (provider.name === 'local') {
      const vec = await embedQuery(message)
      const hits = await tenantQuery(tenantId,
        `SELECT source_type, source_id, metadata->>'text' AS text, 1 - (vector <=> $1::vector) AS score
         FROM embeddings ORDER BY vector <=> $1::vector LIMIT 4`, [`[${vec.join(',')}]`])
      semantic = hits.rows.filter((r) => r.score > 0)
    }

    // Synthesize and stream token-by-token (word chunks for the local provider).
    let toolNames = observations.map((o) => o.tool)
    const lines = []
    for (const o of observations) {
      if (o.tool === 'search_records' && o.result.length) lines.push(...o.result.map((r) => `${r.order_id}: ${r.customer} ${r.grade} ${r.mt}MT (${r.status})`))
      else if (o.tool === 'search_crm' && o.result.length) lines.push(...o.result.map((r) => `${r.kind}: ${r.label}${r.detail ? ' — ' + r.detail : ''}`))
      else if (o.tool === 'get_crm_kpi' && o.result) lines.push(`CRM: ${o.result.companies} companies, ${o.result.contacts} contacts, ${o.result.open_leads} open leads, ${o.result.open_deals} open deals ($${Math.round(o.result.pipeline_value).toLocaleString('en-US')} pipeline), ${o.result.open_tasks} open tasks (${o.result.overdue_tasks} overdue)`)
      else if (o.tool === 'get_kpi' && o.result) lines.push(`KPIs: ${o.result.open_orders} orders, ${o.result.active_mt} MT, ${o.result.suppliers} suppliers`)
      else if (o.tool === 'get_issues' && o.result.length) lines.push(...o.result.map((i) => `${i.ticket_id} [${i.category}] ${i.description}`))
      else if (o.tool === 'get_party' && o.result.length) lines.push(...o.result.map((p) => `${p.name} (${p.type})`))
      else if (o.tool === 'run_sql' && o.result) {
        if (o.result.error) lines.push(`SQL tool: ${o.result.error}`)
        else if (o.result.rows?.length) lines.push(`SQL result (${o.result.rowCount} rows): ${JSON.stringify(o.result.rows.slice(0, 5)).slice(0, 400)}`)
        else lines.push('SQL result: no rows')
      }
    }
    if (chart) lines.push(`Chart ready: ${chart.title} — rendered below.`)
    for (const s of semantic) lines.push(`[${s.source_type} ${s.source_id}] ${s.text}`)
    const context = lines.join('\n')

    let tokensOut = 0, tokensIn = 0, sdkReply = ''
    if (provider.name !== 'local') {
      // SDK agent path (AI SDK v5): streamed tool-calls + text deltas.
      try {
        const stream = streamText({
          model: makeSdkModel(provider),
          system: `You are a B2B CRM + operations assistant for tenant "${tenantId}". Answer grounded in the tenant's data using the provided tools. Be concise and specific. Prefer the dedicated search/KPI tools; only use run_sql for questions they cannot answer (a single read-only SELECT). Once you have relevant results, answer immediately — do not repeat similar tool calls. If the tools don't contain the answer, say so.`,
          messages: [...mem.history.slice(-8).map((t) => ({ role: t.role, content: t.text })), { role: 'user', content: message }],
          tools: sdkTools(tenantId),
          stopWhen: stepCountIs(8),
        })
        const toolResults = []
        for await (const part of stream.fullStream) {
          if (part.type === 'tool-call') send('tool', { name: part.toolName })
          else if (part.type === 'tool-result') {
            toolResults.push({ toolName: part.toolName, result: part.result })
            send('observation', { tool: part.toolName, count: Array.isArray(part.result) ? part.result.length : 1 })
          }
          else if (part.type === 'text-delta') send('token', { text: part.text })
        }
        const usage = await stream.usage
        tokensIn = usage.inputTokens || 0
        tokensOut = usage.outputTokens || 0
        toolNames = [...toolNames, ...(await stream.toolCalls).map((c) => c.toolName)]
        sdkReply = await stream.text
        if (!sdkReply || !sdkReply.trim()) {
          // Step budget exhausted before a final answer — stream a synthesized
          // one from the tool observations so the user never gets silence.
          const obsLines = toolResults.map((r) => `${r.toolName}: ${JSON.stringify(r.result).slice(0, 300)}`)
          sdkReply = obsLines.length ? `Based on ${tenantId}'s data (tools: ${toolNames.join(', ')}):\n${obsLines.join('\n')}` : `Nothing found for "${message}".`
          for (const w of sdkReply.split(/(\s+)/)) { send('token', { text: w }); await new Promise((r) => setTimeout(r, 8)) }
        }
      } catch (e) {
        send('token', { text: `(LLM unavailable: ${e.message.slice(0,80)}) Falling back to data:\n` })
        const fallback = context ? `Based on ${tenantId}'s data:\n${context}` : `Nothing found for "${message}".`
        for (const w of fallback.split(/(\s+)/)) { send('token', { text: w }); await new Promise((r) => setTimeout(r, 8)) }
      }
    } else {
      const full = context ? `Based on ${tenantId}'s data:\n${context}` : `Nothing found for "${message}".`
      for (const w of full.split(/(\s+)/)) {
        send('token', { text: w })
        tokensOut++
        await new Promise((r) => setTimeout(r, 8))
      }
    }
    const latency = Date.now() - t0
    await saveTurn(tenantId, session_id, { userText: message, assistantText: sdkReply || context || 'ok', tools: toolNames, chart: chart ? { ...chartIntent, spec: chart } : null })
    await logUsage(tenantId, { requestId, provider: provider.name, model: provider.model, tool: toolNames.join(',') || 'planner', tokensIn, tokensOut, costUsd: 0, latencyMs: latency })
    send('done', { tools: toolNames, chart, usage: { provider: provider.name, model: provider.model, latency_ms: latency, request_id: requestId, tokens_in: tokensIn, tokens_out: tokensOut } })
    reply.raw.end()
  })

  // ---- Insights generator — computes and stores a snapshot ----
  // CRM insights cover every tenant (the core schema); the rubber-vertical
  // lines are appended only when the tenant actually holds vertical rows.
  async function computeInsights(tenantId, vertical) {
    const [totals, topPipeline, byStage, bySource, tasks, months] = await Promise.all([
      tenantQuery(tenantId, `SELECT
        (SELECT count(*) FROM companies)::int AS companies, (SELECT count(*) FROM contacts)::int AS contacts,
        (SELECT count(*) FROM leads)::int AS leads, (SELECT count(*) FROM deals)::int AS deals,
        (SELECT coalesce(sum(value),0) FROM deals)::float AS pipeline`),
      tenantQuery(tenantId, `SELECT c.name AS name, coalesce(sum(d.value),0)::float AS v
        FROM deals d JOIN companies c ON c.id = d.company_id WHERE d.status='open'
        GROUP BY 1 ORDER BY v DESC LIMIT 1`),
      tenantQuery(tenantId, `SELECT stage, count(*)::int AS n, coalesce(sum(value),0)::float AS v
        FROM deals WHERE status='open' GROUP BY stage ORDER BY v DESC LIMIT 5`),
      tenantQuery(tenantId, `SELECT source, count(*)::int AS n FROM leads
        GROUP BY source ORDER BY n DESC LIMIT 3`),
      tenantQuery(tenantId, `SELECT count(*) FILTER (WHERE NOT completed)::int AS open_tasks,
        count(*) FILTER (WHERE NOT completed AND due_at < now())::int AS overdue
        FROM activities WHERE type='task'`),
      tenantQuery(tenantId, `SELECT to_char(date_trunc('month', coalesce(expected_close_date, created_at)),'YYYY-MM') AS m,
        coalesce(sum(value),0)::float AS v FROM deals GROUP BY 1 ORDER BY 1`),
    ])
    const usd = (x) => `$${Math.round(x).toLocaleString('en-US')}`
    const crm = [
      `CRM: ${totals.rows[0].companies} companies, ${totals.rows[0].contacts} contacts, ${totals.rows[0].leads} leads, ${totals.rows[0].deals} deals (${usd(totals.rows[0].pipeline)} total pipeline).`,
      `Top open pipeline: ${topPipeline.rows[0]?.name || 'n/a'} (${usd(topPipeline.rows[0]?.v || 0)}).`,
      `Open pipeline by stage: ${byStage.rows.map((r) => `${r.stage}=${usd(r.v)} (${r.n})`).join(', ') || 'none'}.`,
      `Leads by source: ${bySource.rows.map((r) => `${r.source}=${r.n}`).join(', ') || 'none'}.`,
      `Tasks: ${tasks.rows[0].open_tasks} open, ${tasks.rows[0].overdue} overdue.`,
      `Expected deal value by month: ${months.rows.map((r) => `${r.m}=${usd(r.v)}`).join(' → ') || 'n/a'}.`,
    ]
    if (!vertical) return crm

    const [topCust, topGrade, issueMix, trend, vTotals] = await Promise.all([
      tenantQuery(tenantId, `SELECT customer, sum(mt)::float AS mt FROM records GROUP BY customer ORDER BY mt DESC LIMIT 3`),
      tenantQuery(tenantId, `SELECT grade, sum(mt)::float AS mt FROM records GROUP BY grade ORDER BY mt DESC LIMIT 3`),
      tenantQuery(tenantId, `SELECT category, count(*)::int AS n FROM tickets GROUP BY category ORDER BY n DESC`),
      tenantQuery(tenantId, `SELECT to_char(date_trunc('month', date),'YYYY-MM') AS m, sum(mt)::float AS mt FROM records GROUP BY 1 ORDER BY 1`),
      tenantQuery(tenantId, `SELECT count(*)::int AS orders, coalesce(sum(mt),0)::float AS mt, coalesce(sum(mt*price_usd),0)::float AS revenue FROM records`),
    ])
    return [...crm,
      `Top customer by volume: ${topCust.rows[0]?.customer || 'n/a'} (${topCust.rows[0]?.mt || 0} MT).`,
      `Top grade: ${topGrade.rows[0]?.grade || 'n/a'} (${topGrade.rows[0]?.mt || 0} MT).`,
      `Open issues by category: ${issueMix.rows.map((r) => `${r.category}=${r.n}`).join(', ') || 'none'}.`,
      `Monthly volume trend: ${trend.rows.map((r) => `${r.m}=${r.mt}MT`).join(' → ') || 'n/a'}.`,
      `Totals: ${vTotals.rows[0].orders} orders, ${vTotals.rows[0].mt} MT, $${(vTotals.rows[0].revenue / 1e6).toFixed(2)}M revenue.`,
    ]
  }

  async function storeSnapshot(tenantId, provider) {
    const vertical = await hasVerticalData(tenantId)
    const insights = await computeInsights(tenantId, vertical)
    await tenantQuery(tenantId,
      `INSERT INTO insights_snapshots (tenant_id, insights, provider) VALUES (app.current_tenant(), $1::jsonb, $2)`,
      [JSON.stringify(insights), provider])
    return insights
  }

  fastify.post('/insights', async (req) => {
    const tenantId = req.headers['x-tenant-id']
    if (!tenantId) return { error: 'x-tenant-id required' }
    const t0 = Date.now()
    const requestId = crypto.randomUUID()
    const provider = pickProvider(tenantId)
    const insights = await storeSnapshot(tenantId, provider.name)
    await logUsage(tenantId, { requestId, provider: provider.name, model: provider.model, tool: 'insights', tokensIn: 0, tokensOut: insights.join(' ').length, costUsd: 0, latencyMs: Date.now() - t0 })
    return { tenant: tenantId, insights, generated_at: new Date().toISOString(), usage: { provider: provider.name, request_id: requestId } }
  })

  // Latest stored snapshot (loaded automatically by the Insights screen).
  fastify.get('/insights/latest', async (req) => {
    const tenantId = req.headers['x-tenant-id']
    if (!tenantId) return { error: 'x-tenant-id required' }
    const r = await tenantQuery(tenantId,
      `SELECT insights, provider, created_at FROM insights_snapshots ORDER BY created_at DESC LIMIT 1`)
    if (!r.rows.length) return { tenant: tenantId, insights: [], note: 'no snapshot yet — call POST /insights' }
    return { tenant: tenantId, insights: r.rows[0].insights, generated_at: r.rows[0].created_at, provider: r.rows[0].provider }
  })

  // ---- Nightly insights snapshots (cron) ----
  // Compute a snapshot for every active tenant so the Insights screen auto-loads.
  async function snapshotAllTenants() {
    try {
      const client = await pool.connect()
      let tenants = []
      try {
        const r = await client.query('SELECT id FROM app.tenants WHERE status=$1', ['active'])
        tenants = r.rows.map((t) => t.id)
      } finally { client.release() }
      for (const t of tenants) {
        try { await storeSnapshot(t, 'cron') } catch (e) { fastify.log.warn({ msg: `snapshot failed for ${t}`, err: e.message }) }
      }
      fastify.log.info(`insights snapshots computed for ${tenants.length} tenants`)
    } catch (e) { fastify.log.error('snapshotAllTenants failed', e) }
  }

  return { app: fastify, snapshotAllTenants }
}
