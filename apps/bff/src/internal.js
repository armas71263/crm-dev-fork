import crypto from 'crypto'

// Internal data gateway (Phase 6.5, credential-free agent): the AI service
// holds NO database credentials. Every query it needs is a named op in this
// registry, executed on the BFF's RLS-scoped pools with the tenant GUC applied
// server-side from the validated x-tenant-id header. Model-written SQL has its
// own endpoint (/internal/sql) behind the same token plus the read-only
// guardrails. Auth is a shared internal token — never exposed to browsers.

// Chart dimension/metric whitelists — the AI service sends keys, the SQL is
// assembled only from these maps (no client SQL fragments reach the DB).
const V_CHART = {
  grade: { from: 'records', dim: 'grade' },
  customer: { from: 'records', dim: 'customer' },
  supplier: { from: 'records', dim: 'supplier' },
  status: { from: 'records', dim: 'status' },
  category: { from: 'tickets', dim: 'category' },
  month: { from: 'records', dim: "to_char(date_trunc('month', date), 'YYYY-MM')" },
}
const V_METRICS = { mt: 'sum(mt)', fcl: 'sum(fcl)', count: 'count(*)', revenue: 'sum(mt*price_usd)', avg_price: 'avg(price_usd)' }
const C_CHART = {
  stage: { from: 'deals', dim: 'stage' },
  company: { from: 'deals d JOIN companies c ON c.id = d.company_id', dim: 'c.name' },
  source: { from: 'leads', dim: `coalesce(source,'n/a')` },
  status: { from: 'leads', dim: 'status' },
  type: { from: 'activities', dim: 'type' },
  month: { from: 'deals', dim: "to_char(date_trunc('month', coalesce(expected_close_date, created_at)), 'YYYY-MM')" },
}

const vChartSql = ({ dimension, metric, filter }) => {
  const spec = V_CHART[dimension] || V_CHART.customer
  const met = V_METRICS[metric] || V_METRICS.count
  let where = '', params = []
  if (filter && spec.from === 'records') { where = 'WHERE grade ILIKE $1 OR customer ILIKE $1 OR supplier ILIKE $1'; params = [`%${filter}%`] }
  return { text: `SELECT ${spec.dim} AS label, ${met}::float AS value FROM ${spec.from} ${where} GROUP BY 1 ORDER BY ${dimension === 'month' ? '1 ASC' : '2 DESC'} LIMIT 20`, params }
}
const cChartSql = ({ dimension, metric, filter }) => {
  const spec = C_CHART[dimension] || C_CHART.stage
  const met = metric === 'value' || metric === 'revenue' ? 'sum(value)' : metric === 'avg_value' || metric === 'avg_price' ? 'avg(value)' : 'count(*)'
  let where = '', params = []
  if (filter) { where = `WHERE ${spec.dim} ILIKE $1`; params = [`%${filter}%`] }
  return { text: `SELECT ${spec.dim} AS label, ${met}::float AS value FROM ${spec.from} ${where} GROUP BY 1 ORDER BY ${dimension === 'month' ? '1 ASC' : '2 DESC'} LIMIT 20`, params }
}

// Read-only SQL guardrails (authoritative copy for /internal/sql — the AI
// service pre-validates to fail fast, but THIS is the wall that matters).
const SQL_FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|grant|revoke|copy|create|call|do|vacuum|listen|notify|lock|set|reset|begin|commit|rollback|execute)\b/i
export function validateSql(sql) {
  const t = String(sql || '').trim().replace(/;+\s*$/, '')
  if (!t) return { error: 'empty query' }
  if (t.includes(';')) return { error: 'only a single statement is allowed' }
  if (!/^(select|with)\b/i.test(t)) return { error: 'only SELECT (or WITH ... SELECT) queries are allowed' }
  if (SQL_FORBIDDEN.test(t)) return { error: 'read-only queries only — forbidden keyword detected' }
  return { sql: t }
}
export function registerInternalRoutes(fastify, { staffQuery, runReadonly }) {
  // Every op: [param-picking, sql-or-function]. Executed with the tenant GUC
  // set from the header inside the gateway handler — never from query text.
  const OPS = {
    // ---- structured tool queries ----
    search_records: [(p) => [`%${p.q}%`], `SELECT order_id, customer, supplier, grade, mt, fcl, price_usd, status FROM records
      WHERE customer ILIKE $1 OR supplier ILIKE $1 OR order_id ILIKE $1 OR grade ILIKE $1
      ORDER BY created_at DESC LIMIT 5`],
    get_kpi: [() => [], `SELECT
      count(*)::int AS open_orders, coalesce(sum(mt),0)::float AS active_mt,
      count(DISTINCT supplier)::int AS suppliers, count(DISTINCT customer)::int AS customers
      FROM records`],
    get_issues: [() => [], `SELECT ticket_id, category, status, description FROM tickets WHERE status<>'Resolved' ORDER BY created_at DESC LIMIT 5`],
    get_party: [(p) => [`%${p.q}%`], `SELECT name, type, contact FROM parties WHERE name ILIKE $1 LIMIT 5`],
    vertical_chart: [(p) => vChartSql(p).params, (p) => vChartSql(p).text],
    search_crm: [(p) => [`%${p.q}%`], `SELECT * FROM (
      (SELECT 'company' AS kind, name::text AS label, coalesce(type,'') AS detail FROM companies WHERE name ILIKE $1 OR coalesce(industry,'') ILIKE $1 LIMIT 3)
      UNION ALL (SELECT 'contact', full_name, coalesce(title,'') FROM contacts WHERE full_name ILIKE $1 OR coalesce(email,'') ILIKE $1 LIMIT 3)
      UNION ALL (SELECT 'lead', name, coalesce(company_name,'') FROM leads WHERE name ILIKE $1 OR coalesce(company_name,'') ILIKE $1 LIMIT 3)
      UNION ALL (SELECT 'deal', name, coalesce(stage,'') FROM deals WHERE name ILIKE $1 LIMIT 3)
      UNION ALL (SELECT 'activity', subject, coalesce(type,'') FROM activities WHERE subject ILIKE $1 OR coalesce(detail,'') ILIKE $1 LIMIT 3)
    ) sub LIMIT 9`],
    get_crm_kpi: [() => [], `SELECT
      (SELECT count(*) FROM companies)::int AS companies,
      (SELECT count(*) FROM contacts)::int AS contacts,
      (SELECT count(*) FROM leads WHERE status NOT IN ('won','lost','converted','disqualified','closed'))::int AS open_leads,
      (SELECT count(*) FROM deals WHERE status='open')::int AS open_deals,
      (SELECT coalesce(sum(value),0) FROM deals WHERE status='open')::float AS pipeline_value,
      (SELECT count(*) FROM activities WHERE type='task' AND NOT completed)::int AS open_tasks,
      (SELECT count(*) FROM activities WHERE type='task' AND NOT completed AND due_at < now())::int AS overdue_tasks`],
    crm_chart: [(p) => cChartSql(p).params, (p) => cChartSql(p).text],
    get_forecast: [(p) => [p.series], `SELECT series, model, horizon, history, forecast, generated_at FROM predictions WHERE series = $1`],
    vertical_probe: [() => [], 'SELECT 1 AS has FROM records LIMIT 1'],

    // ---- semantic retrieval over the embeddings table ----
    semantic_search: [(p) => [p.vector], `SELECT source_type, source_id, metadata->>'text' AS text, 1 - (vector <=> $1::vector) AS score
      FROM embeddings ORDER BY vector <=> $1::vector LIMIT 4`],

    // ---- conversation memory ----
    memory_load: [(p) => [p.session_key], `SELECT m.role, m.content, m.chart FROM ai_chat_messages m
      JOIN ai_chat_sessions s ON s.id = m.session_id
      WHERE s.session_key = $1 ORDER BY m.id DESC LIMIT 10`],
    memory_upsert_session: [(p) => [p.session_key], `INSERT INTO ai_chat_sessions (tenant_id, session_key) VALUES (app.current_tenant(), $1)
      ON CONFLICT (tenant_id, session_key) DO UPDATE SET updated_at = now() RETURNING id`],
    memory_save_turn: [(p) => [p.session_id, p.role, p.content, JSON.stringify(p.tools || []), p.chart ? JSON.stringify(p.chart) : null],
      `INSERT INTO ai_chat_messages (tenant_id, session_id, role, content, tools, chart)
       VALUES (app.current_tenant(), $1, $2, $3, $4::jsonb, $5::jsonb)`],

    // ---- usage accounting / budgets ----
    usage_log: [(p) => [p.request_id, p.provider, p.model, p.tool, p.tokens_in ?? 0, p.tokens_out ?? 0, p.cost_usd ?? 0, p.latency_ms ?? 0],
      `INSERT INTO ai_usage_logs (tenant_id, request_id, provider, model, tool, tokens_in, tokens_out, cost_usd, latency_ms)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8)`],
    usage_budget: [() => [], `SELECT coalesce(sum(tokens_in + tokens_out),0)::int AS tokens FROM ai_usage_logs WHERE created_at > now() - interval '24 hours'`],

    // ---- indexing (embeddings live in the AI service; rows come from here) ----
    index_sources: [() => [], `SELECT * FROM (
      (SELECT order_id::text AS id, 'record' AS type, 'Order '||order_id||': '||customer||' buying '||mt||' MT of '||grade||' from '||supplier||' at $'||price_usd||'/MT, status '||status AS text FROM records)
      UNION ALL (SELECT ticket_id::text, 'ticket', 'Ticket '||ticket_id||' ('||category||', '||status||'): '||description FROM tickets)
      UNION ALL (SELECT name, 'party', type||' '||name||' contact '||coalesce(contact->>'name', contact::text, 'n/a') FROM parties)
      UNION ALL (SELECT name, 'company', 'Company '||name||' ('||type||coalesce(', '||industry,'')||')' FROM companies)
      UNION ALL (SELECT full_name, 'contact', 'Contact '||full_name||coalesce(', '||title,'') FROM contacts)
      UNION ALL (SELECT name, 'lead', 'Lead '||name||' for '||coalesce(company_name,'n/a')||' worth $'||coalesce(value,0) FROM leads)
      UNION ALL (SELECT name, 'deal', 'Deal '||name||' at stage '||stage||' worth $'||coalesce(value,0) FROM deals)
      UNION ALL (SELECT subject, 'activity', initcap(type)||': '||subject||coalesce(' — '||left(detail,120),'') FROM activities)
    ) sub`],
    index_clear: [() => [], 'DELETE FROM embeddings'],
    index_insert: [(p) => [p.type, String(p.id), JSON.stringify({ text: p.text }), `[${(p.vector || []).join(',')}]`],
      `INSERT INTO embeddings (tenant_id, source_type, source_id, metadata, vector)
       VALUES (app.current_tenant(), $1, $2, $3::jsonb, $4::vector)`],

    // ---- insights (exact shapes the AI insights composer expects) ----
    ins_totals: [() => [], `SELECT
      (SELECT count(*) FROM companies)::int AS companies, (SELECT count(*) FROM contacts)::int AS contacts,
      (SELECT count(*) FROM leads)::int AS leads, (SELECT count(*) FROM deals)::int AS deals,
      (SELECT coalesce(sum(value),0) FROM deals)::float AS pipeline`],
    ins_top_pipeline: [() => [], `SELECT c.name AS name, coalesce(sum(d.value),0)::float AS v
      FROM deals d JOIN companies c ON c.id = d.company_id WHERE d.status='open'
      GROUP BY 1 ORDER BY v DESC LIMIT 1`],
    ins_by_stage: [() => [], `SELECT stage, count(*)::int AS n, coalesce(sum(value),0)::float AS v
      FROM deals WHERE status='open' GROUP BY stage ORDER BY v DESC LIMIT 5`],
    ins_leads_source: [() => [], `SELECT source, count(*)::int AS n FROM leads
      GROUP BY source ORDER BY n DESC LIMIT 3`],
    ins_tasks: [() => [], `SELECT count(*) FILTER (WHERE NOT completed)::int AS open_tasks,
      count(*) FILTER (WHERE NOT completed AND due_at < now())::int AS overdue
      FROM activities WHERE type='task'`],
    ins_deal_months: [() => [], `SELECT to_char(date_trunc('month', coalesce(expected_close_date, created_at)),'YYYY-MM') AS m,
      coalesce(sum(value),0)::float AS v FROM deals GROUP BY 1 ORDER BY 1`],
    ins_top_customers: [() => [], `SELECT customer, sum(mt)::float AS mt FROM records GROUP BY customer ORDER BY mt DESC LIMIT 3`],
    ins_top_grades: [() => [], `SELECT grade, sum(mt)::float AS mt FROM records GROUP BY grade ORDER BY mt DESC LIMIT 3`],
    ins_issue_mix: [() => [], `SELECT category, count(*)::int AS n FROM tickets GROUP BY category ORDER BY n DESC`],
    ins_v_trend: [() => [], `SELECT to_char(date_trunc('month', date),'YYYY-MM') AS m, sum(mt)::float AS mt FROM records GROUP BY 1 ORDER BY 1`],
    ins_v_totals: [() => [], `SELECT count(*)::int AS orders, coalesce(sum(mt),0)::float AS mt, coalesce(sum(mt*price_usd),0)::float AS revenue FROM records`],
    // ---- evidence ledger + suggestions ----
    observation_insert: [(p) => [p.source, p.entity_type, p.entity_id ?? null, p.observation_type, JSON.stringify(p.observed ?? {})],
      `INSERT INTO ai_observations (tenant_id, source, entity_type, entity_id, observation_type, observed)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5::jsonb) RETURNING id, created_at`],
    suggestion_insert: [(p) => [p.entity_type, p.entity_id, p.field, p.current_value ?? null, JSON.stringify(p.proposed_value ?? null), p.evidence ?? ''],
      `INSERT INTO ai_suggestions (tenant_id, entity_type, entity_id, field, current_value, proposed_value, evidence)
       VALUES (app.current_tenant(), $1, $2, $3, $4::jsonb, $5::jsonb, $6) RETURNING id, created_at`],

    // ---- durable agent tasks ----
    task_insert: [(p) => [p.task_type, JSON.stringify(p.payload ?? {}), p.due_at || new Date().toISOString()],
      `INSERT INTO agent_tasks (tenant_id, task_type, payload, due_at)
       VALUES (app.current_tenant(), $1, $2::jsonb, $3) RETURNING id, task_type, due_at, status`],
    task_claim: [(p) => [p.lease_seconds ?? 300], `UPDATE agent_tasks SET status='running', lease_expires_at = now() + ($1 || ' seconds')::interval, attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM agent_tasks
        WHERE (status='pending' AND due_at <= now())
           OR (status='running' AND lease_expires_at < now())
        ORDER BY due_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
      RETURNING id, task_type, payload, attempts`],
    task_finish: [(p) => [p.status, p.result ? JSON.stringify(p.result) : null, (p.error || '').slice(0, 500), p.id],
      `UPDATE agent_tasks SET status=$1, result=$2::jsonb, error=$3, lease_expires_at=NULL, updated_at=now()
       WHERE id=$4 RETURNING id, status`],
    task_list: [() => [], `SELECT id, task_type, payload, status, due_at, attempts, result, error, created_at, updated_at
      FROM agent_tasks ORDER BY created_at DESC LIMIT 25`],
    tenants_all: [() => [], 'SELECT id FROM app.tenants WHERE status=$1'],
  }
  // tenants_all needs its param; patch it through a dedicated entry.
  OPS.tenants_all = [(p) => [p.status || 'active'], 'SELECT id FROM app.tenants WHERE status=$1']

  const requireToken = (req, reply) => {
    const expected = process.env.BFF_INTERNAL_TOKEN
    if (!expected) { reply.code(503).send({ error: 'internal gateway not configured' }); return false }
    const got = req.headers['x-internal-token']
    if (!got || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
      reply.code(401).send({ error: 'internal token required' })
      return false
    }
    return true
  }

  fastify.post('/internal/data', async (req, reply) => {
    if (!requireToken(req, reply)) return reply
    const { op, params = {} } = req.body || {}
    const tenantId = req.headers['x-tenant-id']
    if (!tenantId || !/^[a-z0-9-]{1,40}$/.test(tenantId)) return reply.code(400).send({ error: 'valid x-tenant-id required' })
    const def = OPS[op]
    if (!def) return reply.code(404).send({ error: `unknown op ${op}` })
    const [pick, sql] = def
    try {
      const paramsArr = pick(params)
      const text = typeof sql === 'function' ? sql(params) : sql
      const r = await staffQuery(tenantId, text, paramsArr)
      return { rows: r.rows }
    } catch (e) {
      return { error: `op ${op} failed: ${e.message.slice(0, 160)}` }
    }
  })

  // Model-written SQL: the read-only guardrails (validateSql) live in the BFF
  // now — the AI service only forwards the string, it has no readonly pool.
  fastify.post('/internal/sql', async (req, reply) => {
    if (!requireToken(req, reply)) return reply
    const tenantId = req.headers['x-tenant-id']
    if (!tenantId || !/^[a-z0-9-]{1,40}$/.test(tenantId)) return reply.code(400).send({ error: 'valid x-tenant-id required' })
    const { sql } = req.body || {}
    if (!sql) return reply.code(400).send({ error: 'sql required' })
    const check = validateSql(sql)
    if (check.error) return { error: check.error }
    return runReadonly(tenantId, check.sql)
  })
}
