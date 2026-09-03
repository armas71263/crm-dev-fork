import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, makeTenantQuery, embed, plan, detectChartIntent, pickProvider } from '../src/app.js'

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
  assert.deepEqual(plan('show me the overview').map((c) => c.name), ['get_kpi'])
  assert.deepEqual(plan('table tennis').map((c) => c.name), ['get_kpi'], 'unmatched text falls back to get_kpi')
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
    [/count\(\*\)::int AS open_orders/, [{ open_orders: 3, active_mt: 120.5, suppliers: 2, customers: 4 }]],
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
  assert.match(b.reply, /3 open orders/)
  assert.deepEqual(b.tools, ['get_kpi'])
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
    [/count\(\*\)::int AS open_orders/, [{ open_orders: 1, active_mt: 1, suppliers: 1, customers: 1 }]],
    [/INSERT INTO ai_usage_logs/, [], 'usage table down'],
  ])
  const res = await app.inject({
    method: 'POST',
    url: '/chat',
    headers: { 'x-tenant-id': 'alpha' },
    payload: { message: 'overview please' },
  })
  assert.equal(res.statusCode, 200)
  assert.match(JSON.parse(res.body).reply, /1 open orders/)
  await app.close()
})

// ---- /index: RLS-scoped reindex ----
test('POST /index embeds every record/ticket/party row in the tenant', async () => {
  const { app, fake } = await makeApp([
    [/FROM records/, [{ id: 'ORD-1', type: 'record', text: 'Order ORD-1' }, { id: 'ORD-2', type: 'record', text: 'Order ORD-2' }]],
    [/FROM tickets/, [{ id: 'T-1', type: 'ticket', text: 'Ticket T-1' }]],
    [/FROM parties/, [{ id: 'BKT', type: 'party', text: 'supplier BKT contact X' }]],
  ])
  const res = await app.inject({ method: 'POST', url: '/index', headers: { 'x-tenant-id': 'alpha' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { tenant: 'alpha', indexed: 4 })
  assert.ok(fake.calls.some((c) => c.text === 'DELETE FROM embeddings'), 'reindex must clear the old tenant embeddings')
  const inserts = fake.calls.filter((c) => /INSERT INTO embeddings/.test(c.text))
  assert.equal(inserts.length, 4)
  const vec = inserts[0].params[3]
  assert.match(vec, /^\[-?[\d.e-]+,/)
  assert.equal(vec.split(',').length, 768, 'stored vector must be the full 768-dim embedding')
  const missing = await app.inject({ method: 'POST', url: '/index' })
  assert.equal(JSON.parse(missing.body).error, 'x-tenant-id required')
  await app.close()
})

// ---- /insights + /insights/latest ----
test('POST /insights computes and stores a 5-line snapshot per tenant', async () => {
  const { app, fake } = await makeApp([
    [/GROUP BY customer/, [{ customer: 'CEAT', mt: 100 }]],
    [/GROUP BY grade/, [{ grade: 'TSR-20', mt: 100 }]],
    [/GROUP BY category/, [{ category: 'quality', n: 2 }]],
    [/date_trunc\('month', date\),'YYYY-MM'/, [{ m: '2026-08', mt: 100 }]],
    [/coalesce\(sum\(mt\*price_usd\),0\)/, [{ orders: 5, mt: 100, revenue: 200000 }]],
  ])
  const res = await app.inject({ method: 'POST', url: '/insights', headers: { 'x-tenant-id': 'alpha' } })
  assert.equal(res.statusCode, 200)
  const b = JSON.parse(res.body)
  assert.equal(b.insights.length, 5)
  assert.match(b.insights[0], /Top customer by volume: CEAT \(100 MT\)/)
  assert.match(b.insights[4], /Totals: 5 orders, 100 MT, \$0\.20M revenue/)
  const snap = fake.calls.find((c) => /INSERT INTO insights_snapshots/.test(c.text))
  assert.ok(snap, 'insights must be persisted for the Insights screen')
  assert.equal(JSON.parse(snap.params[0]).length, 5)
  assert.equal(snap.params[1], 'local')
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

// ---- /chat/stream: SSE surface (start/tool/done frames, local synthesis) ----
test('POST /chat/stream emits SSE frames and closes cleanly', async () => {
  const { app } = await makeApp([
    [/count\(\*\)::int AS open_orders/, [{ open_orders: 2, active_mt: 8, suppliers: 1, customers: 2 }]],
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
  assert.match(res.body, /event: tool\ndata: \{"name":"get_kpi"\}/)
  assert.match(res.body, /event: done/)
  assert.match(res.body, /event: token/)
  const noTenant = await app.inject({ method: 'POST', url: '/chat/stream', payload: { message: 'x' } })
  assert.equal(noTenant.statusCode, 400)
  await app.close()
})
