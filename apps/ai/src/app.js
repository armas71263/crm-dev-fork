import Fastify from 'fastify'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
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

// Versioned skills (Phase 6.5): the agent's behavioral rules live as markdown
// files in apps/ai/skills — reviewable and diffable like any other source.
export function loadSkills(dir) {
  const skillsDir = dir || path.join(path.dirname(fileURLToPath(import.meta.url)), '../skills')
  try {
    return fs.readdirSync(skillsDir).filter((f) => f.endsWith('.md')).sort()
      .map((f) => `## ${f.replace(/\.md$/, '')}\n${fs.readFileSync(path.join(skillsDir, f), 'utf8').trim()}`).join('\n\n')
  } catch { return '' }
}

export async function buildApp({ gateway, logger = true }) {
  const fastify = Fastify({ logger })
  // Credential-free agent (Phase 6.5): every DB touch is a named op executed
  // by the BFF's internal gateway (token-authed, RLS-scoped, SQL defined
  // server-side). This service holds NO database credentials at all.
  const gw = async (tid, op, params = {}) => {
    const r = await gateway(tid, op, params)
    if (r.error) throw new Error(r.error)
    return r.rows || []
  }
  const skills = loadSkills()
  const systemPrompt = (tenantId) => `You are a B2B CRM + operations assistant for tenant "${tenantId}". Answer grounded in the tenant's data using the provided tools. Be concise and specific. Prefer the dedicated search/KPI tools; only use run_sql for questions they cannot answer (a single read-only SELECT). Once you have relevant results, answer immediately — do not repeat similar tool calls. If the tools don't contain the answer, say so.\n\n${skills}`

  // ---- Conversation memory (Phase 4): turns persist in Postgres, RLS-scoped
  // ---- per tenant. A DB hiccup degrades to no-history — chat never breaks.
  async function loadMemory(tenantId, sessionKey) {
    const key = sessionKey || 'default'
    try {
      const rows = (await gw(tenantId, 'memory_load', { session_key: key })).reverse()
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
      const sid = (await gw(tenantId, 'memory_upsert_session', { session_key: key }))[0]?.id
      if (!sid) return
      await gw(tenantId, 'memory_save_turn', { session_id: sid, role: 'user', content: userText })
      await gw(tenantId, 'memory_save_turn', { session_id: sid, role: 'assistant', content: assistantText, tools: tools || [], chart })
    } catch (e) {
      fastify.log.warn({ err: e.message }, 'chat memory save failed — turn not persisted')
    }
  }

  // ---- Text-to-SQL execution: app_readonly pool, transaction-local tenant
  // ---- GUC + statement timeout. Any error fails closed with a message.
  // Model-written SQL goes through the BFF's /internal/sql (validateSql +
  // app_readonly pool live THERE now — the authoritative wall).
  const runReadonly = (tenantId, sql) => gateway(tenantId, '__sql', { sql })

  // Vertical (rubber-trading) data is template-specific; the CRM schema is
  // universal. Vertical tools run only for tenants whose vertical tables
  // actually hold rows — an RLS-scoped presence probe, cached briefly.
  const VERTICAL_CACHE = new Map()
  const hasVerticalData = async (tenantId) => {
    const hit = VERTICAL_CACHE.get(tenantId)
    if (hit && Date.now() - hit.ts < 60000) return hit.has
    let has = false
    try { has = (await gw(tenantId, 'vertical_probe')).length > 0 } catch { has = false }
    VERTICAL_CACHE.set(tenantId, { ts: Date.now(), has })
    return has
  }

  // Usage logging — every AI call is accounted per tenant. Failures are logged
  // and swallowed so an accounting hiccup never breaks a chat reply.
  async function logUsage(tenantId, { requestId, provider, model, tool, tokensIn = 0, tokensOut = 0, costUsd = 0, latencyMs = 0 }) {
    try {
      await gw(tenantId, 'usage_log', { request_id: requestId, provider, model, tool, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd, latency_ms: latencyMs })
    } catch (e) { fastify.log.warn({ msg: 'usage log failed', err: e.message }) }
  }

  fastify.get('/health', async () => ({ ok: true, service: 'ai' }))

  // ---- Agent tools — each returns tenant-scoped structured data ----
  const TOOLS = {
    search_records: async (tenantId, { q }) => gw(tenantId, 'search_records', { q }),
    get_kpi: async (tenantId) => (await gw(tenantId, 'get_kpi'))[0] || {},
    get_issues: async (tenantId) => gw(tenantId, 'get_issues'),
    get_party: async (tenantId, { q }) => gw(tenantId, 'get_party', { q }),
    // suggest_chart: aggregates via the BFF gateway (dimension/metric are
    // whitelisted keys server-side — no SQL fragments cross the wire).
    suggest_chart: async (tenantId, { dimension, metric = 'count', title, filter }) => {
      const rows = await gw(tenantId, 'vertical_chart', { dimension, metric, filter })
      return { chart: { type: dimension === 'month' ? 'line' : 'bar', title: title || `${metric} by ${dimension}`, labels: rows.map(x => x.label), values: rows.map(x => x.value) } }
    },

    // ---- Generic CRM tools (companies/contacts/leads/deals/activities) ----
    search_crm: async (tenantId, { q }) => gw(tenantId, 'search_crm', { q }),
    get_crm_kpi: async (tenantId) => (await gw(tenantId, 'get_crm_kpi'))[0] || {},
    suggest_crm_chart: async (tenantId, { dimension, metric = 'count', title, filter }) => {
      const rows = await gw(tenantId, 'crm_chart', { dimension, metric, filter })
      return { chart: { type: dimension === 'month' ? 'line' : 'bar', title: title || `${metric} by ${dimension}`, labels: rows.map(x => x.label), values: rows.map(x => x.value) } }
    },

    // get_forecast: reads the tenant's stored forecast (predictions table).
    get_forecast: async (tenantId, { series = 'record_mt' }) => {
      const rows = await gw(tenantId, 'get_forecast', { series })
      if (!rows.length) return { error: 'no stored forecast for this series - generate one from the Dashboard forecast panel first' }
      return rows[0]
    },

    // run_sql: LLM- or user-written SELECT, executed behind the guardrails.
    run_sql: async (tenantId, { q, sql }) => {
      const check = validateSql(sql || extractSql(q))
      if (check.error) return { error: check.error }
      return runReadonly(tenantId, check.sql)
    },

    // ---- Phase 6.5 trust tools: the agent may observe and propose, never write ----
    record_observation: async (tenantId, { source = 'assistant', entityType, entityId = null, observationType, observed }) => {
      if (!entityType || !observationType) return { error: 'entityType and observationType are required' }
      const rows = await gw(tenantId, 'observation_insert', { source, entity_type: entityType, entity_id: entityId, observation_type: observationType, observed })
      return { recorded: true, observation_id: rows[0]?.id || null }
    },
    propose_change: async (tenantId, { entityType, entityId, field, currentValue = null, proposedValue, evidence = '' }) => {
      if (!entityType || !entityId || !field || proposedValue === undefined || proposedValue === null) {
        return { error: 'entityType, entityId, field and proposedValue are required' }
      }
      const rows = await gw(tenantId, 'suggestion_insert', { entity_type: entityType, entity_id: entityId, field, current_value: currentValue, proposed_value: proposedValue, evidence })
      return { proposed: true, suggestion_id: rows[0]?.id || null, note: 'queued for human review — the record itself was not changed' }
    },
    schedule_task: async (tenantId, { taskType, dueAt, payload = {} }) => {
      if (!taskType) return { error: 'taskType is required' }
      const rows = await gw(tenantId, 'task_insert', { task_type: taskType, due_at: dueAt, payload })
      return { scheduled: true, task_id: rows[0]?.id || null, due_at: rows[0]?.due_at, status: rows[0]?.status }
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
      record_observation: {
        d: 'Record something you directly observed (never an inference): a document field you read, a signature block, an explicit statement by the user. Observations are evidence, not facts — humans decide.',
        s: { type: 'object', properties: { source: { type: 'string', description: "where you observed it, e.g. 'assistant', 'doc-checker'" }, entityType: { type: 'string', description: 'company | contact | lead | deal' }, entityId: { type: 'string', description: 'the record id, when known' }, observationType: { type: 'string', description: 'short slug, e.g. signature-block, user-statement' }, observed: { type: 'object', description: 'the raw observation payload — what was actually seen' } }, required: ['entityType', 'observationType', 'observed'] },
      },
      propose_change: {
        d: 'Propose a field change on a CRM record for human review. NEVER claims to change anything — it queues a suggestion that a person accepts or rejects. Use for any update/write the user requests.',
        s: { type: 'object', properties: { entityType: { type: 'string', description: 'company | contact | lead | deal' }, entityId: { type: 'string' }, field: { type: 'string', description: 'the record field to change' }, currentValue: { type: 'string', description: 'the current value, if known' }, proposedValue: { type: 'string', description: 'the proposed new value' }, evidence: { type: 'string', description: 'what was observed that supports this change' } }, required: ['entityType', 'entityId', 'field', 'proposedValue'] },
      },
      schedule_task: {
        d: 'Schedule a background task: insights_refresh (recompute insights snapshot) or forecast_refresh (retrain the volume forecast). Use when the user asks for follow-up or recurring work.',
        s: { type: 'object', properties: { taskType: { type: 'string', description: 'insights_refresh | forecast_refresh' }, dueAt: { type: 'string', description: 'ISO timestamp; defaults to now' }, payload: { type: 'object', description: 'task-specific params, e.g. {series: "record_mt"}' } }, required: ['taskType'] },
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
    const sources = await gw(tenantId, 'index_sources')

    await gw(tenantId, 'index_clear')
    let indexed = 0
    // Real embeddings (bge-base 768-d) when configured — one batched call;
    // deterministic hash embedder otherwise.
    let vectors = null
    try { vectors = await realEmbed(sources.map((s) => s.text)) }
    catch (e) { fastify.log.warn({ err: e.message }, 'real embeddings unavailable — hash fallback') }
    for (const [i, s] of sources.entries()) {
      const vec = vectors ? vectors[i] : embed(s.text)
      await gw(tenantId, 'index_insert', { type: s.type, id: String(s.id), text: s.text, vector: vec })
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
      const hits = await gw(tenantId, 'semantic_search', { vector: `[${vec.join(',')}]` })
      semantic = hits.filter((r) => r.score > 0)
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
          system: systemPrompt(tenantId),
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
      const hits = await gw(tenantId, 'semantic_search', { vector: `[${vec.join(',')}]` })
      semantic = hits.filter((r) => r.score > 0)
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
          system: systemPrompt(tenantId),
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
      gw(tenantId, 'ins_totals'), gw(tenantId, 'ins_top_pipeline'), gw(tenantId, 'ins_by_stage'),
      gw(tenantId, 'ins_leads_source'), gw(tenantId, 'ins_tasks'), gw(tenantId, 'ins_deal_months'),
    ])
    const usd = (x) => `$${Math.round(x).toLocaleString('en-US')}`
    const crm = [
      `CRM: ${totals[0].companies} companies, ${totals[0].contacts} contacts, ${totals[0].leads} leads, ${totals[0].deals} deals (${usd(totals[0].pipeline)} total pipeline).`,
      `Top open pipeline: ${topPipeline[0]?.name || 'n/a'} (${usd(topPipeline[0]?.v || 0)}).`,
      `Open pipeline by stage: ${byStage.map((r) => `${r.stage}=${usd(r.v)} (${r.n})`).join(', ') || 'none'}.`,
      `Leads by source: ${bySource.map((r) => `${r.source}=${r.n}`).join(', ') || 'none'}.`,
      `Tasks: ${tasks[0].open_tasks} open, ${tasks[0].overdue} overdue.`,
      `Expected deal value by month: ${months.map((r) => `${r.m}=${usd(r.v)}`).join(' → ') || 'n/a'}.`,
    ]
    if (!vertical) return crm

    const [topCust, topGrade, issueMix, trend, vTotals] = await Promise.all([
      gw(tenantId, 'ins_top_customers'), gw(tenantId, 'ins_top_grades'), gw(tenantId, 'ins_issue_mix'),
      gw(tenantId, 'ins_v_trend'), gw(tenantId, 'ins_v_totals'),
    ])
    return [...crm,
      `Top customer by volume: ${topCust[0]?.customer || 'n/a'} (${topCust[0]?.mt || 0} MT).`,
      `Top grade: ${topGrade[0]?.grade || 'n/a'} (${topGrade[0]?.mt || 0} MT).`,
      `Open issues by category: ${issueMix.map((r) => `${r.category}=${r.n}`).join(', ') || 'none'}.`,
      `Monthly volume trend: ${trend.map((r) => `${r.m}=${r.mt}MT`).join(' → ') || 'n/a'}.`,
      `Totals: ${vTotals[0].orders} orders, ${vTotals[0].mt} MT, $${(vTotals[0].revenue / 1e6).toFixed(2)}M revenue.`,
    ]
  }

  async function storeSnapshot(tenantId, provider) {
    const vertical = await hasVerticalData(tenantId)
    const insights = await computeInsights(tenantId, vertical)
    await gw(tenantId, 'snapshot_insert', { insights, provider })
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
    const rows = await gw(tenantId, 'insights_latest')
    if (!rows.length) return { tenant: tenantId, insights: [], note: 'no snapshot yet — call POST /insights' }
    return { tenant: tenantId, insights: rows[0].insights, generated_at: rows[0].created_at, provider: rows[0].provider }
  })

  // ---- Nightly insights snapshots (cron) ----
  // Compute a snapshot for every active tenant so the Insights screen auto-loads.
  async function snapshotAllTenants() {
    try {
      // app.tenants has no tenant-RLS (it IS the registry); the gateway needs
      // some tenant for the session GUC — the value is irrelevant here.
      const tenants = (await gw('system', 'tenants_all', { status: 'active' })).map((t) => t.id)
      for (const t of tenants) {
        try { await storeSnapshot(t, 'cron') } catch (e) { fastify.log.warn({ msg: `snapshot failed for ${t}`, err: e.message }) }
      }
      fastify.log.info(`insights snapshots computed for ${tenants.length} tenants`)
    } catch (e) { fastify.log.error('snapshotAllTenants failed', e) }
  }


  // ---- Phase 6.5: durable agent task dispatcher ----
  // Claims due/expired-lease rows via FOR UPDATE SKIP LOCKED (the op runs in
  // the BFF); budget-gated against the tenant's 24h AI usage; runs on its own
  // schedule, independent of any request.
  const DAILY_BUDGET = parseInt(process.env.AGENT_DAILY_TOKEN_BUDGET || '200000', 10)
  const TASK_HANDLERS = {
    insights_refresh: async (tenantId) => {
      const insights = await storeSnapshot(tenantId, 'agent-task')
      return { insights: insights.length }
    },
    forecast_refresh: async (tenantId, payload) => {
      const res = await fetch(`${process.env.PREDICTIONS_SERVICE_URL || 'http://localhost:5100'}/forecast`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({ series: payload?.series || 'record_mt' }),
      })
      if (!res.ok) throw new Error(`predictions service ${res.status}`)
      return await res.json()
    },
  }
  async function runOneTask(tenantId) {
    const claimed = await gw(tenantId, 'task_claim', { lease_seconds: 300 })
    const task = claimed[0]
    if (!task) return false
    try {
      const spent = (await gw(tenantId, 'usage_budget'))[0]?.tokens || 0
      if (spent > DAILY_BUDGET) throw new Error(`daily token budget exceeded (${spent}/${DAILY_BUDGET})`)
      const handler = TASK_HANDLERS[task.task_type]
      if (!handler) throw new Error(`unknown task_type ${task.task_type}`)
      const result = await handler(tenantId, task.payload || {})
      await gw(tenantId, 'task_finish', { id: task.id, status: 'done', result })
    } catch (e) {
      await gw(tenantId, 'task_finish', { id: task.id, status: 'failed', error: e.message }).catch(() => {})
    }
    return true
  }
  async function dispatchTick() {
    try {
      const tenants = (await gw('system', 'tenants_all', { status: 'active' })).map((t) => t.id)
      for (const id of tenants) {
        for (let i = 0; i < 5; i++) { if (!await runOneTask(id)) break }
      }
    } catch (e) { fastify.log.warn({ err: e.message }, 'task dispatch tick failed') }
  }
  const dispatchTimer = setInterval(dispatchTick, 30000)
  if (dispatchTimer.unref) dispatchTimer.unref()
  fastify.addHook('onClose', () => clearInterval(dispatchTimer))

  return { app: fastify, snapshotAllTenants, dispatchTick }
}
