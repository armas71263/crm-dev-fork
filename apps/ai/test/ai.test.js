import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, makeTenantQuery, embed, plan, detectChartIntent, pickProvider, validateSql, extractSql } from '../src/app.js'

// ---- Fake pg pool: records every query, serves canned rows by SQL match ----
function makeFakePool(matchers = []) {
  const calls = []
  const released = []
  const client = {
    async query(text, params) {
      calls.push({ text, params })
      for (const [re, rows, fail] of matchers) {
        if (re.test(text)) {
          if (fail) throw new Error(typeof fail === 'string' ? fail : 'boom')
          return { rows }
        }
      }
      return { rows: [] }
    },
    release() { released.push(true) },
  }
  return { pool: { connect: async () => client }, calls, released }
}

async function makeApp(matchers = []) {
  const fake = makeFakePool([
    [/^SELECT set_config/, [{ set_config: 't' }]],
    [/^RESET /, []],
    ...matchers,
  ])
  const { app } = await buildApp({ pool: fake.pool, logger: false })
  return { app, fake }
}

afterEach(() => {
  delete process.env.AI_PROVIDER
  delete process.env.OPENROUTER_API_KEY
  delete process.env.NIM_API_KEY
  delete process.env.OPENAI_API_KEY
})

// ---- RLS session hygiene (same contract as the BFF) ----
test('AI tenantQuery scopes the session per tenant and always releases the client', async () => {
  const { pool, calls, released } = makeFakePool()
  const tq = makeTenantQuery(pool)
  await tq('lexley', 'SELECT 1 FROM records', ['p'])
  assert.deepEqual(calls[0], { text: "SELECT set_config('app.tenant_id', $1, false)", params: ['lexley'] })
  assert.equal(calls[1].text, 'SELECT 1 FROM records')
  assert.deepEqual(calls[1].params, ['p'])
  assert.equal(calls[2].text, 'RESET app.tenant_id')
  assert.equal(released.length, 1)

  const failing = makeFakePool([[/SELECT 1/, [], 'db down']])
  const tq2 = makeTenantQuery(failing.pool)
  await assert.rejects(() => tq2('lexley', 'SELECT 1'))
  assert.equal(failing.released.length, 1, 'client must be released when the query throws')

  const deadReset = makeFakePool([[/^RESET /, [], 'connection lost']])
  const tq3 = makeTenantQuery(deadReset.pool)
  await tq3('lexley', 'SELECT 1')
  assert.equal(deadReset.released.length, 1, 'client must be released even when RESET fails')
})

// ---- Provider router ----
test('pickProvider defaults to local and falls back from key-gated providers without keys', () => {
  assert.equal(pickProvider('a').name, 'local')
  process.env.AI_PROVIDER = 'openrouter'
  assert.equal(pickProvider('a').name, 'local', 'no key → fall back to deterministic local')
  process.env.OPENROUTER_API_KEY = 'sk-test'
  const p = pickProvider('beta')
  assert.equal(p.name, 'openrouter')
  assert.equal(p.tenantId, 'beta')
  assert.equal(p.model, 'anthropic/claude-3.5-sonnet')
  process.env.AI_PROVIDER = 'bogus'
  const p2 = pickProvider('a')
  assert.equal(p2.name, 'local', 'unknown provider env must not bypass the router')
})

// ---- Deterministic embeddings (drives RAG, indexing and semantic search) ----
test('embed is deterministic, 768-dim and L2-normalized', () => {
  const a = embed('TSR-20 natural rubber order from Tiong Huat')
  const b = embed('TSR-20 natural rubber order from Tiong Huat')
  assert.equal(a.length, 768)
  assert.deepEqual(a, b, 'same input must embed identically every time')
  const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0))
  assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit norm, got ${norm}`)
})

test('embed distinguishes different texts and never emits NaN', () => {
  const a = embed('order grade TSR-20')
  const b = embed('quality ticket moisture defect')
  assert.ok(a.some((x, i) => x !== b[i]), 'different texts must produce different vectors')
  assert.ok(a.every(Number.isFinite), 'no NaN in the embedding')
  assert.ok(a.some((x) => x !== 0), 'vector must not be all zeros')
})

test('embed is safe for empty and non-ASCII input', () => {
  const empty = embed('')
  assert.equal(empty.length, 768)
  assert.ok(empty.every(Number.isFinite), 'empty text must embed cleanly (all zero is fine)')
  const ascii = embed('Tĥé qüïck 布朗 rubber')
  assert.ok(ascii.every(Number.isFinite))
  assert.ok(ascii.some((x) => x !== 0))
})

// ---- Planner keyword routing ----
test('plan routes messages to the right tools', () => {
  assert.deepEqual(plan('moisture issue on the order from a TSR-20 supplier').map((c) => c.name), ['get_issues', 'search_records', 'get_party'])
  assert.deepEqual(plan('who is our latex supplier').map((c) => c.name), ['search_records', 'get_party'])
  assert.deepEqual(plan('show me the overview').map((c) => c.name), ['get_crm_kpi', 'get_kpi'])
  assert.deepEqual(plan('table tennis').map((c) => c.name), ['get_crm_kpi'], 'unmatched text falls back to the CRM KPI tool')
  assert.deepEqual(plan('how is the CEAT deal going', { vertical: false }).map((c) => c.name), ['search_crm'])
  assert.deepEqual(plan('deals pipeline overview', { vertical: false }).map((c) => c.name), ['search_crm', 'get_crm_kpi'])
  assert.deepEqual(plan('moisture issue on the order from a TSR-20 supplier', { vertical: false }).map((c) => c.name), ['get_crm_kpi'], 'vertical questions degrade to the CRM fallback without vertical data')
})

// ---- Chart intent detection ----
test('detectChartIntent returns null without chart keywords or a prior chart', () => {
  assert.equal(detectChartIntent('hello there'), null)
  assert.equal(detectChartIntent('now just TSR-20'), null, 'bare filter without a prior chart is not an intent')
})

test('detectChartIntent maps dimension and metric keywords', () => {
  assert.deepEqual(detectChartIntent('show a chart of grade breakdown'), { dimension: 'grade', metric: 'count', filter: null })
  assert.deepEqual(detectChartIntent('plot revenue by supplier'), { dimension: 'supplier', metric: 'revenue', filter: null })
  assert.deepEqual(detectChartIntent('monthly trend of mt volume'), { dimension: 'month', metric: 'mt', filter: null })
  assert.deepEqual(detectChartIntent('top 5 customers'), { dimension: 'customer', metric: 'count', filter: null })
  assert.deepEqual(detectChartIntent('container fcl breakdown by status'), { dimension: 'status', metric: 'fcl', filter: null })
})

test('detectChartIntent refines a prior chart from a bare filter (multi-turn)', () => {
  const session = { lastChart: { dimension: 'grade', metric: 'mt', filter: null } }
  assert.deepEqual(detectChartIntent('now just TSR-20', session), { dimension: 'grade', metric: 'mt', filter: 'tsr-20' })
})

// ---- /chat: validation, local synthesis, chart intent, usage logging ----
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
    [/SELECT 1 FROM records LIMIT 1/, []],
    [/count\(\*\) FROM companies/, [{ companies: 3, contacts: 5, open_leads: 2, open_deals: 1, pipeline_value: 145000, open_tasks: 2, overdue_tasks: 1 }]],
    [/FROM embeddings/, [{ source_type: 'record', source_id: 'ORD-1', text: 'Order ORD-1', score: 0.5 }]],
  ])
  const res = await app.inject({
    method: 'POST',
    url: '/chat',
    headers: { 'x-tenant-id': 'alpha' },
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
  const usage = fake.calls.find((c) => /INSERT INTO ai_usage_logs/.test(c.text))
  assert.ok(usage, 'every chat turn must be accounted in ai_usage_logs')
  assert.ok(usage.params.some((p) => typeof p === 'string' && p.length === 36), 'usage log must carry a uuid request_id')
  await app.close()
})

test('POST /chat builds and refines charts across turns (multi-turn session)', async () => {
  const { app, fake } = await makeApp([
    [/SELECT 1 FROM records LIMIT 1/, [{ one: 1 }]],
    [/JOIN ai_chat_sessions s ON s\.id = m\.session_id/, [
      { role: 'assistant', content: 'chart ready', chart: { dimension: 'grade', metric: 'mt', filter: null, spec: { type: 'bar', title: 'mt by grade', labels: ['TSR-20', 'SMR-20'], values: [10, 5] } } },
    ]],
    [/ON CONFLICT \(tenant_id, session_key\)/, [{ id: 1 }]],
    [/SELECT grade AS label/, [
      { label: 'TSR-20', value: 10 },
      { label: 'SMR-20', value: 5 },
    ]],
    [/FROM embeddings/, []],
  ])
  const first = await app.inject({
    method: 'POST',
    url: '/chat',
    headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'show a grade chart by mt', session_id: 's1' },
  })
  const b1 = JSON.parse(first.body)
  assert.equal(b1.chart.type, 'bar')
  assert.deepEqual(b1.chart.labels, ['TSR-20', 'SMR-20'])
  assert.equal(b1.chart.title, 'mt by grade')

  const second = await app.inject({
    method: 'POST',
    url: '/chat',
    headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'now just TSR-20', session_id: 's1' },
  })
  const b2 = JSON.parse(second.body)
  assert.ok(b2.chart, 'bare filter must refine the previous chart instead of replying without one')
  const refined = fake.calls.find((c) => /WHERE grade ILIKE \$1/.test(c.text))
  assert.deepEqual(refined.params, ['%tsr-20%'], 'the previous chart dimension/metric must be reused with the new filter')
  await app.close()
})

test('POST /chat survives usage-log failures (accounting must not break replies)', async () => {
  const { app } = await makeApp([
    [/SELECT 1 FROM records LIMIT 1/, []],
    [/count\(\*\) FROM companies/, [{ companies: 1, contacts: 1, open_leads: 1, open_deals: 1, pipeline_value: 1, open_tasks: 1, overdue_tasks: 0 }]],
    [/INSERT INTO ai_usage_logs/, [], 'usage table down'],
  ])
  const res = await app.inject({
    method: 'POST',
    url: '/chat',
    headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'overview please' },
  })
  assert.equal(res.statusCode, 200)
  assert.match(JSON.parse(res.body).reply, /CRM: 1 companies/)
  await app.close()
})

// ---- /index: RLS-scoped reindex ----
test('POST /index embeds every record/ticket/party row in the tenant', async () => {
  const { app, fake } = await makeApp([
    [/FROM records/, [{ id: 'ORD-1', type: 'record', text: 'Order ORD-1' }, { id: 'ORD-2', type: 'record', text: 'Order ORD-2' }]],
    [/FROM tickets/, [{ id: 'T-1', type: 'ticket', text: 'Ticket T-1' }]],
    [/FROM parties/, [{ id: 'BKT', type: 'party', text: 'supplier BKT contact X' }]],
    [/FROM companies/, [{ id: 'CEAT', type: 'company', text: 'Company CEAT (customer, Tire manufacturing)' }]],
  ])
  const res = await app.inject({ method: 'POST', url: '/index', headers: { 'x-tenant-id': 'alpha' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { tenant: 'alpha', indexed: 5 })
  assert.ok(fake.calls.some((c) => c.text === 'DELETE FROM embeddings'), 'reindex must clear the old tenant embeddings')
  assert.ok(fake.calls.some((c) => /FROM companies/.test(c.text)), 'reindex must cover the CRM entities, not just the vertical tables')
  const inserts = fake.calls.filter((c) => /INSERT INTO embeddings/.test(c.text))
  assert.equal(inserts.length, 5)
  const vec = inserts[0].params[3]
  assert.match(vec, /^\[-?[\d.e-]+,/)
  assert.equal(vec.split(',').length, 768, 'stored vector must be the full 768-dim embedding')
  const missing = await app.inject({ method: 'POST', url: '/index' })
  assert.equal(JSON.parse(missing.body).error, 'x-tenant-id required')
  await app.close()
})

// ---- /insights + /insights/latest ----
test('POST /insights computes CRM insights for every tenant and appends vertical lines when data exists', async () => {
  const { app, fake } = await makeApp([
    [/SELECT 1 FROM records LIMIT 1/, [{ one: 1 }]],
    [/count\(\*\) FROM companies/, [{ companies: 3, contacts: 2, leads: 2, deals: 2, pipeline: 145000 }]],
    [/JOIN companies c ON c\.id = d\.company_id/, [{ name: 'CEAT', v: 120000 }]],
    [/GROUP BY stage/, [{ stage: 'proposal', n: 1, v: 120000 }]],
    [/GROUP BY source/, [{ source: 'referral', n: 1 }]],
    [/FILTER \(WHERE NOT completed\)/, [{ open_tasks: 2, overdue: 1 }]],
    [/expected_close_date/, [{ m: '2026-12', v: 120000 }]],
    [/GROUP BY customer/, [{ customer: 'CEAT', mt: 100 }]],
    [/GROUP BY grade/, [{ grade: 'TSR-20', mt: 100 }]],
    [/GROUP BY category/, [{ category: 'quality', n: 2 }]],
    [/date_trunc\('month', date\),'YYYY-MM'/, [{ m: '2026-08', mt: 100 }]],
    [/coalesce\(sum\(mt\*price_usd\),0\)/, [{ orders: 5, mt: 100, revenue: 200000 }]],
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
  const snap = fake.calls.find((c) => /INSERT INTO insights_snapshots/.test(c.text))
  assert.ok(snap, 'insights must be persisted for the Insights screen')
  assert.equal(JSON.parse(snap.params[0]).length, 11)
  assert.equal(snap.params[1], 'local')
  await app.close()
})

test('POST /insights stays CRM-only for tenants without vertical data', async () => {
  const { app, fake } = await makeApp([
    [/SELECT 1 FROM records LIMIT 1/, []],
    [/count\(\*\) FROM companies/, [{ companies: 1, contacts: 1, leads: 1, deals: 1, pipeline: 1 }]],
    [/JOIN companies c ON c\.id = d\.company_id/, []],
    [/GROUP BY stage/, []],
    [/GROUP BY source/, []],
    [/FILTER \(WHERE NOT completed\)/, [{ open_tasks: 0, overdue: 0 }]],
    [/expected_close_date/, []],
  ])
  const res = await app.inject({ method: 'POST', url: '/insights', headers: { 'x-tenant-id': 'alpha' } })
  assert.equal(res.statusCode, 200)
  const b = JSON.parse(res.body)
  assert.equal(b.insights.length, 6)
  assert.match(b.insights[0], /CRM: 1 companies, 1 contacts, 1 leads, 1 deals \(\$1 total pipeline\)/)
  assert.ok(fake.calls.every((c) => !/FROM records GROUP BY customer/.test(c.text)), 'vertical queries must not run without vertical data')
  await app.close()
})

test('GET /insights/latest returns the newest snapshot or an empty note pre-cron', async () => {
  const empty = await makeApp()
  const resEmpty = await empty.app.inject({ method: 'GET', url: '/insights/latest', headers: { 'x-tenant-id': 'alpha' } })
  assert.equal(JSON.parse(resEmpty.body).note, 'no snapshot yet — call POST /insights')
  await empty.app.close()

  const { app } = await makeApp([
    [/FROM insights_snapshots ORDER BY created_at/, [{ insights: ['a'], provider: 'cron', created_at: '2026-09-01T00:00:00Z' }]],
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
    [/SELECT 1 FROM records LIMIT 1/, []],
    [/UNION ALL/, [{ kind: 'deal', label: 'CEAT Q4 contract', detail: 'proposal' }]],
    [/FROM embeddings/, []],
  ])
  const res = await app.inject({
    method: 'POST',
    url: '/chat',
    headers: { 'x-tenant-id': 'alpha' },
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
    [/SELECT 1 FROM records LIMIT 1/, []],
    [/SELECT stage AS label/, [
      { label: 'proposal', value: 120000 },
      { label: 'new', value: 25000 },
    ]],
    [/FROM embeddings/, []],
  ])
  const res = await app.inject({
    method: 'POST',
    url: '/chat',
    headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'chart of pipeline value by stage' },
  })
  assert.equal(res.statusCode, 200)
  const b = JSON.parse(res.body)
  assert.equal(b.chart.type, 'bar')
  assert.deepEqual(b.chart.labels, ['proposal', 'new'])
  assert.match(b.chart.title, /revenue by stage/)
  const q = fake.calls.find((c) => /SELECT stage AS label/.test(c.text))
  assert.match(q.text, /sum\(value\)/, 'the revenue metric maps to the CRM deal value')
  await app.close()
})

// ---- /chat/stream: SSE surface (start/tool/done frames, local synthesis) ----
test('POST /chat/stream emits SSE frames and closes cleanly', async () => {
  const { app } = await makeApp([
    [/SELECT 1 FROM records LIMIT 1/, []],
    [/count\(\*\) FROM companies/, [{ companies: 2, contacts: 3, open_leads: 1, open_deals: 1, pipeline_value: 25000, open_tasks: 1, overdue_tasks: 0 }]],
    [/FROM embeddings/, []],
  ])
  const res = await app.inject({
    method: 'POST',
    url: '/chat/stream',
    headers: { 'x-tenant-id': 'alpha' },
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

// ---- Phase 4: text-to-SQL guardrails ----
test('validateSql accepts single SELECTs and rejects dangerous shapes', () => {
  assert.deepEqual(validateSql('SELECT count(*) FROM companies'), { sql: 'SELECT count(*) FROM companies' })
  assert.equal(validateSql('  select 1;  ').sql, 'select 1')
  assert.equal(validateSql('WITH x AS (SELECT 1) SELECT * FROM x').sql, 'WITH x AS (SELECT 1) SELECT * FROM x')
  assert.match(validateSql('').error, /empty/)
  assert.match(validateSql('SELECT 1; SELECT 2').error, /single statement/)
  assert.match(validateSql('DELETE FROM companies').error, /only SELECT/)
  assert.match(validateSql("SELECT * FROM companies WHERE name = 'drop everything'").error, /forbidden keyword/, 'keywords inside literals are rejected too — strict by design')
  assert.equal(extractSql('sql: SELECT count(*) FROM deals'), 'SELECT count(*) FROM deals')
})

test('run_sql runs SELECTs on the readonly pool with tenant GUC + timeout; mutations never reach it', async () => {
  const data = makeFakePool([
    [/^SELECT set_config/, [{ set_config: 't' }]],
    [/^RESET /, []],
    [/JOIN ai_chat_sessions s ON s\.id = m\.session_id/, []],
    [/ON CONFLICT \(tenant_id, session_key\)/, []],
  ])
  const ro = makeFakePool([
    [/^BEGIN$/, []],
    [/^COMMIT$/, []],
    [/statement_timeout/, []],
    [/count\(\*\) FROM companies/, [{ count: '3' }]],
  ])
  const { app } = await buildApp({ pool: data.pool, readonlyPool: ro.pool, logger: false })
  const res = await app.inject({ method: 'POST', url: '/chat', headers: { 'x-tenant-id': 'alpha' }, payload: { message: 'sql: SELECT count(*) FROM companies' } })
  assert.equal(res.statusCode, 200)
  const b = JSON.parse(res.body)
  assert.ok(b.tools.includes('run_sql'))
  assert.match(b.reply, /SQL result/)
  assert.match(b.reply, /"count":"3"/)
  const gucIdx = ro.calls.findIndex((c) => /set_config\('app\.tenant_id'/.test(c.text))
  const qIdx = ro.calls.findIndex((c) => /count\(\*\) FROM companies/.test(c.text))
  assert.ok(gucIdx >= 0 && gucIdx < qIdx, 'transaction-local tenant GUC must precede the query')
  assert.deepEqual(ro.calls[gucIdx].params, ['alpha'])
  assert.ok(ro.calls.some((c) => /statement_timeout/.test(c.text)), 'per-query timeout must be set')

  const roCallsBefore = ro.calls.length
  const bad = await app.inject({ method: 'POST', url: '/chat', headers: { 'x-tenant-id': 'alpha' }, payload: { message: 'sql: DELETE FROM companies' } })
  assert.match(JSON.parse(bad.body).reply, /only SELECT/)
  assert.equal(ro.calls.length, roCallsBefore, 'rejected SQL must never reach the readonly pool')
  await app.close()

  const noRoApp = await buildApp({ pool: data.pool, logger: false })
  const noRoRes = await noRoApp.app.inject({ method: 'POST', url: '/chat', headers: { 'x-tenant-id': 'alpha' }, payload: { message: 'sql: SELECT 1' } })
  assert.match(JSON.parse(noRoRes.body).reply, /not configured/)
  await noRoApp.app.close()
})

test('chat turns persist to ai_chat_messages (Phase 4 conversation memory)', async () => {
  const data = makeFakePool([
    [/^SELECT set_config/, [{ set_config: 't' }]],
    [/^RESET /, []],
    [/JOIN ai_chat_sessions s ON s\.id = m\.session_id/, [{ role: 'user', content: 'earlier question', chart: null }]],
    [/ON CONFLICT \(tenant_id, session_key\)/, [{ id: 42 }]],
  ])
  const { app } = await buildApp({ pool: data.pool, logger: false })
  const res = await app.inject({ method: 'POST', url: '/chat', headers: { 'x-tenant-id': 'alpha' }, payload: { message: 'what is the overview?', session_id: 'mem-test' } })
  assert.equal(res.statusCode, 200)
  const inserts = data.calls.filter((c) => /INSERT INTO ai_chat_messages/.test(c.text))
  assert.equal(inserts.length, 2, 'user + assistant turns must persist')
  assert.equal(inserts[0].params[1], 'what is the overview?')
  assert.equal(inserts[0].params[0], 42, 'messages attach to the upserted session')
  assert.ok(inserts[1].params[1].length > 0, 'assistant reply must be persisted')
  const toolsParam = JSON.parse(inserts[1].params[2])
  assert.ok(Array.isArray(toolsParam), 'tool names persist as JSON')
  await app.close()
})
