import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildApp, embed, plan, detectChartIntent, pickProvider, validateSql, extractSql, realEmbed, loadSkills } from '../src/app.js'

// ---- Fake gateway: records every op call, serves canned rows by op name ----
// Phase 6.5: the AI service holds no DB credentials — tests mock the BFF
// gateway (op + params), exactly like production calls it.
function makeFakeGateway(matchers = []) {
  const calls = []
  const gateway = async (tenantId, op, params = {}) => {
    calls.push({ tenantId, op, params })
    for (const [name, rows, fail] of matchers) {
      if (name === op) {
        if (fail) return { error: typeof fail === 'string' ? fail : 'boom' }
        if (op === '__sql') return rows
        return { rows }
      }
    }
    if (op === '__sql') return { rows: [], rowCount: 0 }
    return { rows: [] }
  }
  return { gateway, calls }
}

async function makeApp(matchers = []) {
  const fake = makeFakeGateway(matchers)
  const { app } = await buildApp({ gateway: fake.gateway, logger: false })
  return { app, fake }
}

afterEach(() => {
  delete process.env.AI_PROVIDER
  delete process.env.OPENROUTER_API_KEY
  delete process.env.NIM_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.CLOUDFLARE_API_TOKEN
  delete process.env.CLOUDFLARE_ACCOUNT_ID
  delete process.env.PREDICTIONS_SERVICE_URL
})

test('pickProvider defaults to local and falls back from key-gated providers without keys', () => {
  assert.equal(pickProvider('a').name, 'local')
  process.env.AI_PROVIDER = 'openrouter'
  assert.equal(pickProvider('a').name, 'local', 'no key → local fallback')
  process.env.OPENROUTER_API_KEY = 'sk-test'
  assert.equal(pickProvider('a').name, 'openrouter')
  assert.equal(pickProvider('a').tenantId, 'a')
})

test('embed is deterministic, 768-dim and L2-normalized', () => {
  const a1 = embed('hello world')
  const a2 = embed('hello world')
  assert.equal(a1.length, 768)
  assert.deepEqual(a1, a2)
  const norm = Math.sqrt(a1.reduce((s, x) => s + x * x, 0))
  assert.ok(Math.abs(norm - 1) < 1e-9)
})

test('embed distinguishes different texts and never emits NaN', () => {
  const a = embed('rubber shipments')
  const b = embed('latex prices')
  let diff = 0
  for (let i = 0; i < 768; i++) { diff += Math.abs(a[i] - b[i]) }
  assert.ok(diff > 0.1, 'different texts must embed differently')
  assert.ok(a.every((x) => Number.isFinite(x)))
})

test('embed is safe for empty and non-ASCII input', () => {
  assert.ok(embed('').every((x) => Number.isFinite(x)))
  assert.ok(embed('ラバーストラック輸出入').every((x) => Number.isFinite(x)))
})

test('plan routes messages to the right tools', () => {
  const sql = plan('sql: SELECT count(*) FROM companies')
  assert.equal(sql[0].name, 'run_sql', 'an explicit sql ask routes to run_sql first')
  const forecast = plan('forecast the upcoming volume', { vertical: true })
  assert.ok(forecast.some((t) => t.name === 'get_forecast'))
  const crm = plan('tell me about the CEAT deal', { vertical: false })
  assert.deepEqual(crm.map((t) => t.name), ['search_crm'])
  const vertical = plan('any open quality issues?', { vertical: true })
  assert.ok(vertical.some((t) => t.name === 'get_issues'))
})

test('detectChartIntent returns null without chart keywords or a prior chart', () => {
  assert.equal(detectChartIntent('hello there'), null)
  assert.equal(detectChartIntent('what is a deal?'), null)
})

test('detectChartIntent maps dimension and metric keywords', () => {
  const c = detectChartIntent('show a chart of pipeline value by stage')
  assert.equal(c.dimension, 'stage')
  assert.equal(c.metric, 'revenue')
})

test('detectChartIntent refines a prior chart from a bare filter (multi-turn)', () => {
  const session = { lastChart: { dimension: 'grade', metric: 'mt', filter: null } }
  const c = detectChartIntent('now just TSR-20', session)
  assert.equal(c.dimension, 'grade')
  assert.equal(c.metric, 'mt')
  assert.equal(c.filter, 'tsr-20')
})

// ---- Skills (Phase 6.5): behavioral rules live as versioned markdown ----
test('loadSkills concatenates markdown files as versioned agent rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'))
  fs.writeFileSync(path.join(dir, 'a-rules.md'), 'Rule A body')
  fs.writeFileSync(path.join(dir, 'b-rules.md'), 'Rule B body')
  const skills = loadSkills(dir)
  assert.match(skills, /## a-rules\nRule A body/)
  assert.match(skills, /## b-rules\nRule B body/)
  assert.ok(skills.indexOf('a-rules') < skills.indexOf('b-rules'), 'skills load in stable sorted order')
  assert.equal(loadSkills(path.join(dir, 'missing')), '')
})

// ---- /chat: local provider ----
test('POST /chat rejects missing tenant or message', async () => {
  const { app } = await makeApp()
  const noTenant = await app.inject({ method: 'POST', url: '/chat', payload: { message: 'x' } })
  assert.equal(noTenant.statusCode, 400)
  assert.equal(JSON.parse(noTenant.body).error, 'x-tenant-id required')
  const noMessage = await app.inject({ method: 'POST', url: '/chat', headers: { 'x-tenant-id': 't' }, payload: {} })
  assert.equal(noMessage.statusCode, 400)
  await app.close()
})

test('POST /chat answers from the local provider using tool observations and logs usage', async () => {
  const { app, fake } = await makeApp([
    ['get_crm_kpi', [{ companies: 3, contacts: 5, open_leads: 2, open_deals: 1, pipeline_value: 145000, open_tasks: 2, overdue_tasks: 1 }]],
    ['semantic_search', [{ source_type: 'record', source_id: 'ORD-1', text: 'Order ORD-1', score: 0.5 }]],
  ])
  const res = await app.inject({
    method: 'POST', url: '/chat', headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'what is the overview?' },
  })
  assert.equal(res.statusCode, 200)
  const b = JSON.parse(res.body)
  assert.match(b.reply, /CRM: 3 companies, 5 contacts, 2 open leads, 1 open deals \(\$145,000 pipeline\), 2 open tasks \(1 overdue\)/)
  assert.match(b.reply, /\[record ORD-1\] Order ORD-1/)
  assert.deepEqual(b.tools, ['get_crm_kpi'])
  assert.equal(b.chart, null)
  assert.equal(b.usage.provider, 'local')
  assert.equal(b.usage.tokens_out, b.reply.length)
  const usage = fake.calls.find((c) => c.op === 'usage_log')
  assert.ok(usage, 'every chat turn must be accounted via the usage_log op')
  assert.equal(typeof usage.params.request_id, 'string')
  assert.equal(usage.params.request_id.length, 36, 'usage log must carry a uuid request_id')
  await app.close()
})

test('POST /chat builds and refines charts across turns (multi-turn session)', async () => {
  const { app, fake } = await makeApp([
    ['vertical_probe', [{ one: 1 }]],
    ['memory_load', [{ role: 'assistant', content: 'chart ready', chart: { dimension: 'grade', metric: 'mt', filter: null, spec: { type: 'bar', title: 'mt by grade', labels: ['TSR-20', 'SMR-20'], values: [10, 5] } } }]],
    ['vertical_chart', [{ label: 'TSR-20', value: 10 }, { label: 'SMR-20', value: 5 }]],
  ])
  const first = await app.inject({
    method: 'POST', url: '/chat', headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'show a grade chart by mt', session_id: 's1' },
  })
  const b1 = JSON.parse(first.body)
  assert.equal(b1.chart.type, 'bar')
  assert.deepEqual(b1.chart.labels, ['TSR-20', 'SMR-20'])
  assert.equal(b1.chart.title, 'mt by grade')

  const second = await app.inject({
    method: 'POST', url: '/chat', headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'now just TSR-20', session_id: 's1' },
  })
  const b2 = JSON.parse(second.body)
  assert.ok(b2.chart, 'bare filter must refine the previous chart instead of replying without one')
  const refined = fake.calls.filter((c) => c.op === 'vertical_chart').pop()
  assert.deepEqual(refined.params, { dimension: 'grade', metric: 'mt', filter: 'tsr-20' }, 'the previous chart dimension/metric must be reused with the new filter')
  await app.close()
})

test('POST /chat survives usage-log failures (accounting must not break replies)', async () => {
  const { app } = await makeApp([
    ['get_crm_kpi', [{ companies: 1, contacts: 1, open_leads: 1, open_deals: 1, pipeline_value: 1, open_tasks: 1, overdue_tasks: 0 }]],
    ['usage_log', [], 'usage table down'],
  ])
  const res = await app.inject({
    method: 'POST', url: '/chat', headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'overview please' },
  })
  assert.equal(res.statusCode, 200)
  assert.match(JSON.parse(res.body).reply, /CRM: 1 companies/)
  await app.close()
})

// ---- /index: gateway reindex ----
test('POST /index embeds every source row via the gateway', async () => {
  const { app, fake } = await makeApp([
    ['index_sources', [
      { id: 'ORD-1', type: 'record', text: 'Order ORD-1' }, { id: 'ORD-2', type: 'record', text: 'Order ORD-2' },
      { id: 'T-1', type: 'ticket', text: 'Ticket T-1' }, { id: 'BKT', type: 'party', text: 'supplier BKT contact X' },
      { id: 'CEAT', type: 'company', text: 'Company CEAT (customer, Tire manufacturing)' },
    ]],
  ])
  const res = await app.inject({ method: 'POST', url: '/index', headers: { 'x-tenant-id': 'alpha' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { tenant: 'alpha', indexed: 5 })
  assert.ok(fake.calls.some((c) => c.op === 'index_clear'), 'reindex must clear the old tenant embeddings')
  const inserts = fake.calls.filter((c) => c.op === 'index_insert')
  assert.equal(inserts.length, 5)
  assert.equal(inserts[0].params.vector.length, 768, 'stored vector must be the full 768-dim embedding')
  assert.ok(fake.calls.some((c) => c.op === 'index_sources' && c.tenantId === 'alpha'), 'sources come from the tenant-scoped gateway op')
  const missing = await app.inject({ method: 'POST', url: '/index' })
  assert.equal(JSON.parse(missing.body).error, 'x-tenant-id required')
  await app.close()
})

// ---- /insights + /insights/latest ----
test('POST /insights computes CRM insights for every tenant and appends vertical lines when data exists', async () => {
  const { app, fake } = await makeApp([
    ['vertical_probe', [{ one: 1 }]],
    ['ins_totals', [{ companies: 3, contacts: 2, leads: 2, deals: 2, pipeline: 145000 }]],
    ['ins_top_pipeline', [{ name: 'CEAT', v: 120000 }]],
    ['ins_by_stage', [{ stage: 'proposal', n: 1, v: 120000 }]],
    ['ins_leads_source', [{ source: 'referral', n: 1 }]],
    ['ins_tasks', [{ open_tasks: 2, overdue: 1 }]],
    ['ins_deal_months', [{ m: '2026-12', v: 120000 }]],
    ['ins_top_customers', [{ customer: 'CEAT', mt: 100 }]],
    ['ins_top_grades', [{ grade: 'TSR-20', mt: 100 }]],
    ['ins_issue_mix', [{ category: 'quality', n: 2 }]],
    ['ins_v_trend', [{ m: '2026-08', mt: 100 }]],
    ['ins_v_totals', [{ orders: 5, mt: 100, revenue: 200000 }]],
  ])
  const res = await app.inject({ method: 'POST', url: '/insights', headers: { 'x-tenant-id': 'alpha' } })
  assert.equal(res.statusCode, 200)
  const b = JSON.parse(res.body)
  assert.equal(b.insights.length, 11)
  assert.match(b.insights[0], /CRM: 3 companies, 2 contacts, 2 leads, 2 deals \(\$145,000 total pipeline\)/)
  assert.match(b.insights[1], /Top open pipeline: CEAT \(\$120,000\)/)
  assert.match(b.insights[2], /Open pipeline by stage: proposal=\$120,000 \(1\)/)
  assert.match(b.insights[3], /Leads by source: referral=1/)
  assert.match(b.insights[4], /Tasks: 2 open, 1 overdue/)
  assert.match(b.insights[5], /Expected deal value by month: 2026-12=\$120,000/)
  assert.match(b.insights[6], /Top customer by volume: CEAT \(100 MT\)/)
  assert.match(b.insights[10], /Totals: 5 orders, 100 MT, \$0\.20M revenue/)
  const snap = fake.calls.find((c) => c.op === 'snapshot_insert')
  assert.ok(snap, 'insights must be persisted for the Insights screen')
  assert.equal(snap.params.insights.length, 11)
  assert.equal(snap.params.provider, 'local')
  await app.close()
})

test('POST /insights stays CRM-only for tenants without vertical data', async () => {
  const { app, fake } = await makeApp([
    ['vertical_probe', []],
    ['ins_totals', [{ companies: 1, contacts: 1, leads: 1, deals: 1, pipeline: 1 }]],
    ['ins_top_pipeline', []], ['ins_by_stage', []], ['ins_leads_source', []],
    ['ins_tasks', [{ open_tasks: 0, overdue: 0 }]], ['ins_deal_months', []],
  ])
  const res = await app.inject({ method: 'POST', url: '/insights', headers: { 'x-tenant-id': 'alpha' } })
  assert.equal(res.statusCode, 200)
  const b = JSON.parse(res.body)
  assert.equal(b.insights.length, 6)
  assert.match(b.insights[0], /CRM: 1 companies, 1 contacts, 1 leads, 1 deals \(\$1 total pipeline\)/)
  assert.ok(fake.calls.every((c) => c.op !== 'ins_top_customers'), 'vertical ops must not run without vertical data')
  await app.close()
})

test('GET /insights/latest returns the newest snapshot or an empty note pre-cron', async () => {
  const empty = await makeApp()
  const resEmpty = await empty.app.inject({ method: 'GET', url: '/insights/latest', headers: { 'x-tenant-id': 'alpha' } })
  assert.equal(JSON.parse(resEmpty.body).note, 'no snapshot yet — call POST /insights')
  await empty.app.close()

  const { app } = await makeApp([
    ['insights_latest', [{ insights: ['a'], provider: 'cron', created_at: '2026-09-01T00:00:00Z' }]],
  ])
  const res = await app.inject({ method: 'GET', url: '/insights/latest', headers: { 'x-tenant-id': 'alpha' } })
  const b = JSON.parse(res.body)
  assert.deepEqual(b.insights, ['a'])
  assert.equal(b.provider, 'cron')
  await app.close()
})

// ---- CRM routing and CRM charts ----
test('POST /chat routes CRM questions to search_crm', async () => {
  const { app } = await makeApp([
    ['vertical_probe', []],
    ['search_crm', [{ kind: 'deal', label: 'CEAT Q4 contract', detail: 'proposal' }]],
    ['semantic_search', []],
  ])
  const res = await app.inject({
    method: 'POST', url: '/chat', headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'tell me about the CEAT deal' },
  })
  assert.equal(res.statusCode, 200)
  const b = JSON.parse(res.body)
  assert.deepEqual(b.tools, ['search_crm'])
  assert.match(b.reply, /deal: CEAT Q4 contract — proposal/)
  await app.close()
})

test('POST /chat builds pipeline charts from the CRM for stage/company/source intents', async () => {
  const { app, fake } = await makeApp([
    ['vertical_probe', []],
    ['crm_chart', [{ label: 'proposal', value: 120000 }, { label: 'new', value: 25000 }]],
    ['semantic_search', []],
  ])
  const res = await app.inject({
    method: 'POST', url: '/chat', headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'chart of pipeline value by stage' },
  })
  assert.equal(res.statusCode, 200)
  const b = JSON.parse(res.body)
  assert.equal(b.chart.type, 'bar')
  assert.deepEqual(b.chart.labels, ['proposal', 'new'])
  assert.match(b.chart.title, /revenue by stage/)
  const q = fake.calls.find((c) => c.op === 'crm_chart')
  assert.equal(q.params.metric, 'revenue', 'the revenue metric maps to the CRM deal value')
  await app.close()
})

// ---- /chat/stream: SSE surface (start/tool/done frames, local synthesis) ----
test('POST /chat/stream emits SSE frames and closes cleanly', async () => {
  const { app } = await makeApp([
    ['vertical_probe', []],
    ['get_crm_kpi', [{ companies: 2, contacts: 3, open_leads: 1, open_deals: 1, pipeline_value: 25000, open_tasks: 1, overdue_tasks: 0 }]],
    ['semantic_search', []],
  ])
  const res = await app.inject({
    method: 'POST', url: '/chat/stream', headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'hi' },
  })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/event-stream/)
  assert.match(res.body, /event: start/)
  assert.match(res.body, /event: tool\ndata: \{"name":"get_crm_kpi"\}/)
  assert.match(res.body, /event: observation\ndata: \{"tool":"get_crm_kpi","count":1\}/)
  assert.match(res.body, /event: done/)
  assert.match(res.body, /event: token/)
  const noTenant = await app.inject({ method: 'POST', url: '/chat/stream', payload: { message: 'x' } })
  assert.equal(noTenant.statusCode, 400)
  await app.close()
})

// ---- Phase 4/6.5: text-to-SQL guardrails + credential-free execution ----
test('validateSql accepts single SELECTs and rejects dangerous shapes', () => {
  assert.deepEqual(validateSql('SELECT count(*) FROM companies'), { sql: 'SELECT count(*) FROM companies' })
  assert.equal(validateSql('  select 1;  ').sql, 'select 1')
  assert.equal(validateSql('WITH x AS (SELECT 1) SELECT * FROM x').sql, 'WITH x AS (SELECT 1) SELECT * FROM x')
  assert.match(validateSql('').error, /empty/)
  assert.match(validateSql('SELECT 1; SELECT 2').error, /single statement/)
  assert.match(validateSql('DELETE FROM companies').error, /only SELECT/)
  assert.match(validateSql("SELECT * FROM companies WHERE name = 'drop everything'").error, /forbidden keyword/)
})

test('run_sql forwards validated SELECTs to the internal sql gateway; mutations never reach it', async () => {
  const { app, fake } = await makeApp([
    ['__sql', { rows: [{ n: 3 }], rowCount: 1 }],
    ['vertical_probe', []],
    ['semantic_search', []],
  ])
  const res = await app.inject({
    method: 'POST', url: '/chat', headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'sql: SELECT count(*) AS n FROM companies' },
  })
  assert.equal(res.statusCode, 200)
  assert.match(JSON.parse(res.body).reply, /SQL result/)
  const sqlCall = fake.calls.find((c) => c.op === '__sql')
  assert.ok(sqlCall, 'validated SELECT must be forwarded to the BFF sql gateway')
  assert.match(sqlCall.params.sql, /^SELECT count/i)

  await app.inject({
    method: 'POST', url: '/chat', headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'sql: DELETE FROM companies' },
  })
  assert.ok(!fake.calls.some((c) => c.op === '__sql' && /delete/i.test(c.params.sql)), 'mutations are rejected before the gateway')
  await app.close()
})

test('chat turns persist via the memory ops (Phase 4 conversation memory)', async () => {
  const { app, fake } = await makeApp([
    ['memory_load', [{ role: 'user', content: 'earlier question', chart: null }]],
    ['memory_upsert_session', [{ id: 42 }]],
    ['vertical_probe', []],
    ['get_crm_kpi', [{ companies: 1, contacts: 1, open_leads: 1, open_deals: 1, pipeline_value: 1, open_tasks: 1, overdue_tasks: 0 }]],
    ['semantic_search', []],
  ])
  const res = await app.inject({ method: 'POST', url: '/chat', headers: { 'x-tenant-id': 'alpha' }, payload: { message: 'what is the overview?', session_id: 'mem-test' } })
  assert.equal(res.statusCode, 200)
  const turns = fake.calls.filter((c) => c.op === 'memory_save_turn')
  assert.equal(turns.length, 2, 'user + assistant turns must persist')
  assert.equal(turns[0].params.session_id, 42, 'messages attach to the upserted session')
  assert.equal(turns[0].params.role, 'user')
  assert.equal(turns[0].params.content, 'what is the overview?')
  assert.equal(turns[1].params.role, 'assistant')
  assert.ok(turns[1].params.content.length > 0, 'assistant reply must be persisted')
  await app.close()
})

// ---- Phase 6.5: durable agent task dispatcher ----
test('dispatchTick claims due tasks, executes them, and records done results', async () => {
  const fake = makeFakeGateway([
    ['tenants_all', [{ id: 'alpha' }]],
    ['task_claim', [{ id: 'task-1', task_type: 'insights_refresh', payload: {}, attempts: 1 }]],
    ['usage_budget', [{ tokens: 100 }]],
    ['vertical_probe', []],
    ['ins_totals', [{ companies: 1, contacts: 1, leads: 1, deals: 1, pipeline: 1 }]],
    ['ins_top_pipeline', []], ['ins_by_stage', []], ['ins_leads_source', []],
    ['ins_tasks', [{ open_tasks: 0, overdue: 0 }]], ['ins_deal_months', []],
    ['snapshot_insert', []],
  ])
  const built = await buildApp({ gateway: fake.gateway, logger: false })
  await built.dispatchTick()
  const claim = fake.calls.find((c) => c.op === 'task_claim')
  assert.equal(claim.tenantId, 'alpha', 'tasks are claimed at tenant scope')
  const finish = fake.calls.find((c) => c.op === 'task_finish')
  assert.ok(finish, 'the task must be finished')
  assert.equal(finish.params.id, 'task-1')
  assert.equal(finish.params.status, 'done')
  assert.equal(finish.params.result.insights, 6)
  await built.app.close()
})

test('dispatchTick refuses to run when the tenant exceeds its daily token budget', async () => {
  const fake = makeFakeGateway([
    ['tenants_all', [{ id: 'alpha' }]],
    ['task_claim', [{ id: 'task-2', task_type: 'insights_refresh', payload: {}, attempts: 1 }]],
    ['usage_budget', [{ tokens: 999999999 }]],
  ])
  const built = await buildApp({ gateway: fake.gateway, logger: false })
  await built.dispatchTick()
  const finish = fake.calls.find((c) => c.op === 'task_finish')
  assert.equal(finish.params.status, 'failed')
  assert.match(finish.params.error, /daily token budget exceeded/)
  assert.ok(!fake.calls.some((c) => c.op === 'snapshot_insert'), 'no work may run past the budget gate')
  await built.app.close()
})

test('forecast_refresh tasks proxy to the predictions service with the tenant header', async () => {
  process.env.PREDICTIONS_SERVICE_URL = 'http://pred.test:5100'
  const real = globalThis.fetch
  let seenUrl = null, seenTenant = null
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('pred.test')) {
      seenUrl = String(url)
      seenTenant = opts.headers['x-tenant-id']
      return { ok: true, json: async () => ({ series: 'record_mt', stored: true }) }
    }
    return real(url, opts)
  }
  try {
    const fake = makeFakeGateway([
      ['tenants_all', [{ id: 'alpha' }]],
      ['task_claim', [{ id: 'task-3', task_type: 'forecast_refresh', payload: { series: 'record_mt' }, attempts: 1 }]],
      ['usage_budget', [{ tokens: 0 }]],
    ])
    const built = await buildApp({ gateway: fake.gateway, logger: false })
    await built.dispatchTick()
    assert.equal(seenUrl, 'http://pred.test:5100/forecast')
    assert.equal(seenTenant, 'alpha')
    const finish = fake.calls.find((c) => c.op === 'task_finish')
    assert.equal(finish.params.status, 'done')
    assert.deepEqual(finish.params.result, { series: 'record_mt', stored: true })
    await built.app.close()
  } finally {
    globalThis.fetch = real
  }
})

test('pickProvider routes to cloudflare only with token AND account, falling back otherwise', () => {
  delete process.env.CLOUDFLARE_ACCOUNT_ID
  process.env.AI_PROVIDER = 'cloudflare'
  delete process.env.CLOUDFLARE_API_TOKEN
  assert.equal(pickProvider('a').name, 'local', 'no token → local')
  process.env.CLOUDFLARE_API_TOKEN = 'cfut-test'
  assert.equal(pickProvider('a').name, 'local', 'no account id → still local (fail closed)')
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct123'
  const p = pickProvider('beta')
  assert.equal(p.name, 'cloudflare')
  assert.equal(p.model, '@cf/qwen/qwen3.8-27b')
  assert.equal(p.tenantId, 'beta')
})

test('realEmbed returns 768-d vectors and degrades to null without config', async () => {
  delete process.env.CLOUDFLARE_API_TOKEN
  delete process.env.CLOUDFLARE_ACCOUNT_ID
  assert.equal(await realEmbed('hello'), null, 'unconfigured → null (hash fallback)')

  process.env.CLOUDFLARE_API_TOKEN = 'cfut-test'
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct123'
  const real = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    assert.match(String(url), /ai\/run\/@cf\/baai\/bge-base-en-v1\.5$/)
    assert.match(opts.headers['cf-aig-gateway-id'], /default/)
    const v1 = new Array(768).fill(0.1); v1[1] = 0.2
    const v2 = new Array(768).fill(0.3); v2[1] = 0.4
    return { ok: true, json: async () => ({ success: true, result: { shape: [2, 768], data: [v1, v2] } }) }
  }
  try {
    const single = await realEmbed('one text')
    assert.equal(single.length, 768)
    const batch = await realEmbed(['a', 'b'])
    assert.equal(batch.length, 2)
    assert.equal(batch[0][1], 0.2)
  } finally {
    globalThis.fetch = real
  }
})
