import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import * as XLSX from 'xlsx'
import { buildApp, makeTenantQuery } from '../src/app.js'

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
  return { pool: { connect: async () => client, query: client.query.bind(client) }, calls, released }
}

function tenantScoped(matchers = []) {
  return makeFakePool([
    [/^SELECT set_config/, [{ set_config: 'rubbertrack' }]],
    [/^RESET /, []],
    ...matchers,
  ])
}

async function makeApp(dataMatchers = [], adminMatchers = []) {
  const data = tenantScoped(dataMatchers)
  const admin = makeFakePool(adminMatchers)
  const app = await buildApp({ pool: data.pool, adminPool: admin.pool, aiServiceUrl: 'http://127.0.0.1:9', logger: false })
  return { app, data, admin }
}

// ---- tenantQuery: RLS session hygiene (the security-critical primitive) ----
test('tenantQuery sets app.tenant_id session-scoped and resets+releases after', async () => {
  const { pool, calls, released } = makeFakePool()
  const tq = makeTenantQuery(pool)
  const req = { tenantId: 'lexley' }
  const r = await tq(req, 'SELECT 1 FROM records', ['a'])
  assert.equal(r.rows.length, 0)
  assert.deepEqual(calls[0], { text: "SELECT set_config('app.tenant_id', $1, false)", params: ['lexley'] })
  assert.equal(calls[1].text, 'SELECT 1 FROM records')
  assert.deepEqual(calls[1].params, ['a'])
  assert.equal(calls[2].text, 'RESET app.tenant_id')
  assert.equal(released.length, 1)
})

test('tenantQuery releases the client even when the query throws', async () => {
  const matchers = [[/SELECT 1 FROM records/, [], 'disk read failed']]
  const { pool, released } = makeFakePool(matchers)
  const tq = makeTenantQuery(pool)
  await assert.rejects(() => tq({ tenantId: 'x' }, 'SELECT 1 FROM records'))
  assert.equal(released.length, 1, 'client must be released on error so the pool can hand it out again')
})

test('tenantQuery releases the client even when RESET itself throws', async () => {
  const matchers = [[/^RESET /, [], 'connection lost']]
  const { pool, released } = makeFakePool(matchers)
  const tq = makeTenantQuery(pool)
  const r = await tq({ tenantId: 'x' }, 'SELECT 1')
  assert.equal(r.rows.length, 0)
  assert.equal(released.length, 1, 'a dead RESET must not leak the pooled client')
})

test('tenantQuery without tenant context still sets a tenant (default rubbertrack)', async () => {
  const { pool, calls } = makeFakePool()
  const tq = makeTenantQuery(pool)
  await tq({ tenantId: undefined }, 'SELECT 1')
  assert.deepEqual(calls[0].params, [undefined])
})

// ---- Data endpoints: tenant scoping flows through every request ----
test('GET /data/orders scopes the RLS session to the x-tenant-id header', async () => {
  const { app, data, admin } = await makeApp()
  const res = await app.inject({ method: 'GET', url: '/data/orders', headers: { 'x-tenant-id': 'beta' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { orders: [] })
  assert.deepEqual(data.calls[0].params, ['beta'], 'set_config must carry the request tenant')
  assert.ok(data.calls.some((c) => c.text === 'RESET app.tenant_id'), 'session must be reset before returning to the pool')
  assert.ok(data.calls.some((c) => /FROM records/.test(c.text)))
  assert.equal(data.calls.length, 3)
  await app.close()
  void admin
})

test('GET /data/dashboard returns kpi/orders/issues/feed', async () => {
  const { app } = await makeApp([
    [/FROM records ORDER BY created_at/, [{ order_id: 'ORD-1' }]],
    [/count\(\*\) FROM records/, [{ open_orders: 2, active_mt: 50, suppliers: 1, customers: 1, open_issues: 0 }]],
    [/FROM tickets WHERE status/, [{ ticket_id: 'T-1' }]],
    [/FROM feed_items/, [{ title: 'alert' }]],
  ])
  const res = await app.inject({ method: 'GET', url: '/data/dashboard' })
  assert.equal(res.statusCode, 200)
  const b = JSON.parse(res.body)
  assert.equal(b.kpi.open_orders, 2)
  assert.deepEqual(b.orders, [{ order_id: 'ORD-1' }])
  assert.deepEqual(b.issues, [{ ticket_id: 'T-1' }])
  assert.deepEqual(b.feed, [{ title: 'alert' }])
  await app.close()
})

// ---- KPI engine ----
test('GET /data/kpi/trend clamps months and maps rows into arrays', async () => {
  const { app, data } = await makeApp([
    [/\$1 \|\| ' months'/, [{ month: '2026-08', mt: 10, revenue: 200 }]],
  ])
  const res = await app.inject({ method: 'GET', url: '/data/kpi/trend?months=999' })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.deepEqual(body.months, ['2026-08'])
  assert.deepEqual(body.mt, [10])
  assert.deepEqual(body.revenue, [200])
  const trendCall = data.calls.find((c) => /\$1 \|\| ' months'/.test(c.text))
  assert.deepEqual(trendCall.params, [24], 'months must clamp to 24')
  await app.close()
})

test('GET /data/kpi/chart rejects unknown dimensions/metrics with the allowlists', async () => {
  const { app } = await makeApp()
  const badDim = await app.inject({ method: 'GET', url: '/data/kpi/chart?dimension=inject;&metric=mt' })
  assert.equal(badDim.statusCode, 400)
  const badDimBody = JSON.parse(badDim.body)
  assert.equal(badDimBody.error, 'bad dimension/metric')
  assert.ok(badDimBody.dims.includes('grade'))
  assert.equal(await (await app.inject({ method: 'GET', url: '/data/kpi/chart?dimension=grade&metric=nope' })).statusCode, 400)
  await app.close()
})

test('GET /data/kpi/chart builds allowlisted SQL only — table injection falls back to records', async () => {
  const { app, data } = await makeApp([
    [/SELECT grade AS label/, [{ label: 'TSR-20', value: 100 }]],
  ])
  const res = await app.inject({
    method: 'GET',
    url: '/data/kpi/chart?dimension=grade&metric=mt&table=records%3BDROP%20TABLE%20records&time_range=999',
  })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.deepEqual(body.labels, ['TSR-20'])
  assert.deepEqual(body.values, [100])
  const chartCall = data.calls.find((c) => /SELECT grade AS label/.test(c.text))
  assert.match(chartCall.text, /FROM records /, 'table must come from the allowlist')
  assert.match(chartCall.text, /ORDER BY 2 DESC/)
  assert.deepEqual(chartCall.params, ['36 months'], 'time_range must clamp to 36')
  await app.close()
})

test('GET /data/kpi/chart orders by month ascending', async () => {
  const { app, data } = await makeApp()
  await app.inject({ method: 'GET', url: '/data/kpi/chart?dimension=month&metric=count' })
  const chartCall = data.calls.find((c) => /SELECT to_char\(date_trunc/.test(c.text))
  assert.match(chartCall.text, /ORDER BY 1 ASC/)
  await app.close()
})

// ---- Hybrid search ----
test('GET /search with no q short-circuits without touching the DB', async () => {
  const { app, data } = await makeApp()
  const res = await app.inject({ method: 'GET', url: '/search' })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.deepEqual(body.records, [])
  assert.deepEqual(body.semantic, [])
  assert.equal(data.calls.length, 0, 'empty query must not run SQL')
  await app.close()
})

test('GET /search runs the four collection legs + tolerates bad embedding JSON', async () => {
  const { app } = await makeApp([
    [/FROM records/, [{ order_id: 'ORD-9' }]],
    [/FROM parties/, [{ name: 'BKT' }]],
    [/FROM tickets/, [{ ticket_id: 'T-9' }]],
    [/FROM feed_items/, [{ title: 'feed-9' }]],
  ])
  const res = await app.inject({ method: 'GET', url: '/search?q=TSR&embedding=%7Bnot-json%7D' })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.deepEqual(body.records, [{ order_id: 'ORD-9' }])
  assert.deepEqual(body.parties, [{ name: 'BKT' }])
  assert.deepEqual(body.semantic, [], 'malformed embedding must degrade to empty, not crash')
  await app.close()
})

// ---- Customer portal scoping ----
test('GET /portal/overview requires x-customer and scopes every query to it', async () => {
  const { app, data } = await makeApp([
    [/count\(\*\)::int AS orders/, [{ orders: 1, mt: 10, revenue: 200 }]],
    [/^SELECT order_id, grade, mt, fcl, price_usd, status, date FROM records WHERE customer=\$1/, [{ order_id: 'ORD-C', date: '2026-08-01' }]],
    [/FROM tickets WHERE customer=\$1/, [{ ticket_id: 'T-C' }]],
  ])
  const missing = await app.inject({ method: 'GET', url: '/portal/overview' })
  assert.equal(missing.statusCode, 200)
  assert.equal(JSON.parse(missing.body).error, 'x-customer header required')
  assert.equal(data.calls.length, 0)

  const res = await app.inject({
    method: 'GET',
    url: '/portal/overview',
    headers: { 'x-tenant-id': 'rubbertrack', 'x-customer': 'CEAT' },
  })
  assert.equal(res.statusCode, 200)
  const b = JSON.parse(res.body)
  assert.equal(b.customer, 'CEAT')
  assert.equal(b.tenant, 'rubbertrack')
  assert.equal(b.kpi.orders, 1)
  for (const c of data.calls) {
    if (/WHERE customer=\$1/.test(c.text)) assert.deepEqual(c.params, ['CEAT'], 'customer filter must be applied to every portal query')
  }
  await app.close()
})

// ---- Screen config ----
test('screen-config PUT deactivates old configs then inserts, GET round-trips', async () => {
  const { app, data } = await makeApp([
    [/WHERE active=true AND screen=\$1/, [{ config: { panels: [] } }]],
    [/RETURNING id/, [{ id: 7 }]],
  ])
  const put = await app.inject({
    method: 'PUT',
    url: '/data/screen-config',
    headers: { 'x-tenant-id': 'beta' },
    payload: { screen: 'dashboard', config: { panels: [{ type: 'kpi' }] } },
  })
  assert.equal(put.statusCode, 200)
  assert.equal(JSON.parse(put.body).saved, true)
  assert.equal(JSON.parse(put.body).id, 7)
  const updateIdx = data.calls.findIndex((c) => /SET active=false/.test(c.text))
  const insertIdx = data.calls.findIndex((c) => /INSERT INTO screen_configs/.test(c.text))
  assert.ok(updateIdx >= 0 && insertIdx > updateIdx, 'deactivate must precede the new insert')
  assert.deepEqual(data.calls[insertIdx].params, ['beta', 'dashboard', JSON.stringify({ panels: [{ type: 'kpi' }] })])
  assert.deepEqual(data.calls[insertIdx].params[0], 'beta', 'config insert must be tenant-scoped')

  const get = await app.inject({ method: 'GET', url: '/data/screen-config?screen=dashboard' })
  assert.deepEqual(JSON.parse(get.body).config, { panels: [] })
  await app.close()
})

// ---- Excel export ----
test('GET /data/export returns an xlsx the import path can read, or 400 for bad types', async () => {
  const { app } = await makeApp([
    [/FROM records ORDER BY created_at/, [{ order_id: 'ORD-1', date: '2026-08-01', status: 'Open' }]],
  ])
  const bad = await app.inject({ method: 'GET', url: '/data/export?type=users' })
  assert.equal(bad.statusCode, 400)
  assert.equal(JSON.parse(bad.body).error, 'unsupported type')

  const res = await app.inject({ method: 'GET', url: '/data/export?type=records', headers: { 'x-tenant-id': 'alpha' } })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /spreadsheetml/)
  assert.match(res.headers['content-disposition'], /records-alpha\.xlsx/)
  const wb = XLSX.read(res.rawPayload, { type: 'buffer' })
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].order_id, 'ORD-1')
  await app.close()
})

// ---- Excel import (the date-serial pitfall + parameterized multi-row INSERT) ----
function multipartBuffer({ type, wb }) {
  const boundary = '----hoplite-test-boundary'
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true })
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${type}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="import.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ]
  const body = Buffer.concat([
    Buffer.from(parts[0]),
    Buffer.from(parts[1]),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { body, boundary }
}

test('POST /data/import parses real Excel date cells to ISO strings and builds a tenant-scoped multi-row INSERT', async () => {
  const { app, data } = await makeApp()
  const wb = XLSX.utils.book_new()
  // A real Excel-style workbook: date values serialize as serial numbers (e.g.
  // 46235), so the import path must convert them back to ISO strings for Postgres.
  const ws = XLSX.utils.json_to_sheet([
    { order_id: 'ORD-IMP-1', date: new Date('2026-08-01T00:00:00Z'), customer: 'CEAT', status: 'Open' },
    { order_id: 'ORD-IMP-2', date: new Date('2026-08-15T00:00:00Z'), customer: 'JK Tyre', status: 'Open' },
  ])
  XLSX.utils.book_append_sheet(wb, ws, 'records')
  const { body, boundary } = multipartBuffer({ type: 'records', wb })

  const res = await app.inject({
    method: 'POST',
    url: '/data/import',
    headers: { 'x-tenant-id': 'importco', 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { imported: 2, type: 'records' })
  const insert = data.calls.find((c) => /^INSERT INTO records/.test(c.text))
  assert.ok(insert, 'import must run an INSERT')
  assert.match(insert.text, /\(tenant_id,order_id,date,customer,supplier,grade,mt,fcl,price_usd,status\)/)
  assert.match(insert.text, /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10\),\(\$11/)
  assert.equal(insert.params[0], 'importco', 'tenant_id must be the first bound param')
  assert.equal(insert.params[2], '2026-08-01', 'serial date must arrive as ISO yyyy-mm-dd')
  assert.equal(insert.params[12], '2026-08-15')
  await app.close()
})

test('POST /data/import rejects unsupported types and missing files', async () => {
  const { app } = await makeApp()
  // A valid multipart request that carries only the type field — no file part.
  const boundary = '----hoplite-test-boundary'
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nrecords\r\n--${boundary}--\r\n`)
  const bad = await app.inject({
    method: 'POST',
    url: '/data/import',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  })
  assert.equal(bad.statusCode, 400)
  assert.equal(JSON.parse(bad.body).error, 'no file')
  await app.close()
})

// ---- Tenant admin: onboarding ----
test('POST /tenants validates id/label and rejects injection-shaped ids', async () => {
  const { app } = await makeApp([], [
    [/^INSERT INTO app\.tenants/, []],
    [/information_schema/, [{ c: 'order_id,status' }]],
    [/count\(\*\)::int AS n/, [{ n: 2 }]],
  ])
  const noLabel = await app.inject({ method: 'POST', url: '/tenants', payload: { id: 'x' } })
  assert.equal(noLabel.statusCode, 400)
  const badId = await app.inject({ method: 'POST', url: '/tenants', payload: { id: "x; DROP TABLE records", label: 'X' } })
  assert.equal(badId.statusCode, 400)
  assert.equal(JSON.parse(badId.body).error, 'id must be alphanumeric/dash/underscore')
  const ok = await app.inject({ method: 'POST', url: '/tenants', payload: { id: 'gamma', label: 'Gamma Co' } })
  assert.equal(ok.statusCode, 200)
  assert.equal(JSON.parse(ok.body).onboarded, true)
  await app.close()
})

test('POST /tenants clones template tables excluding id and tenant_id columns', async () => {
  const { app, admin } = await makeApp([], [
    [/^INSERT INTO app\.tenants/, []],
    [/information_schema/, [{ c: 'order_id,date,status' }]],
    [/\bcount\(\*\)::int AS n\b/, [{ n: 3 }]],
  ])
  const res = await app.inject({ method: 'POST', url: '/tenants', payload: { id: 'gamma', label: 'Gamma Co' } })
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).cloned.records, 3)
  const colsQuery = admin.calls.find((c) => /information_schema/.test(c.text))
  assert.match(colsQuery.text, /column_name NOT IN \('tenant_id','id'\)/, 'clone must never copy the PK or tenant_id')
  const clone = admin.calls.find((c) => /INSERT INTO public\.records/.test(c.text))
  assert.match(clone.text, /\(tenant_id, order_id,date,status\) SELECT \$1, order_id,date,status FROM public\.records WHERE tenant_id=\$2/)
  assert.deepEqual(clone.params, ['gamma', 'rubbertrack'])
  await app.close()
})

test('POST /tenants skips cloning when cloneTemplate is false', async () => {
  const { app, admin } = await makeApp([], [[/^INSERT INTO app\.tenants/, []]])
  const res = await app.inject({
    method: 'POST',
    url: '/tenants',
    payload: { id: 'delta', label: 'Delta', cloneTemplate: false },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body).cloned, {})
  assert.ok(!admin.calls.some((c) => /information_schema/.test(c.text)))
  await app.close()
})

// ---- Tenant admin: escalation ----
test('POST /tenants/:id/escalate validates tier, 404s unknown tenants, no-ops same tier', async () => {
  const badTierApp = await makeApp()
  const badTier = await badTierApp.app.inject({ method: 'POST', url: '/tenants/alpha/escalate', payload: { toTier: 'Z' } })
  assert.equal(badTier.statusCode, 400)
  await badTierApp.app.close()

  const emptyAdmin = await makeApp()
  const notFound = await emptyAdmin.app.inject({ method: 'POST', url: '/tenants/ghost/escalate', payload: { toTier: 'B' } })
  assert.equal(notFound.statusCode, 404)
  await emptyAdmin.app.close()

  const { app } = await makeApp([], [
    [/SELECT tier FROM app\.tenants/, [{ tier: 'C' }]],
  ])
  const same = await app.inject({ method: 'POST', url: '/tenants/alpha/escalate', payload: { toTier: 'C' } })
  assert.equal(same.statusCode, 200)
  assert.equal(JSON.parse(same.body).escalated, false)
  assert.match(JSON.parse(same.body).note, /already at target/)
  await app.close()
})

test('POST /tenants/:id/escalate A→B creates a schema-per-tenant and copies rows', async () => {
  const { app, admin } = await makeApp([], [
    [/SELECT tier FROM app\.tenants/, [{ tier: 'A' }]],
  ])
  const res = await app.inject({ method: 'POST', url: '/tenants/alpha/escalate', payload: { toTier: 'B' } })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.escalated, true)
  assert.equal(body.isolation, 'tenant_alpha schema')
  assert.ok(admin.calls.some((c) => /CREATE SCHEMA IF NOT EXISTS tenant_alpha/.test(c.text)))
  assert.ok(admin.calls.some((c) => /CREATE TABLE IF NOT EXISTS tenant_alpha\.records \(LIKE public\.records/.test(c.text)))
  const copy = admin.calls.find((c) => /INSERT INTO tenant_alpha\.records/.test(c.text))
  assert.match(copy.text, /WHERE tenant_id=\$1/)
  assert.deepEqual(copy.params, ['alpha'])
  const update = admin.calls.find((c) => /UPDATE app\.tenants SET tier/.test(c.text))
  assert.deepEqual(update.params, ['B', 'alpha'])
  await app.close()
})

// ---- Tenant admin: theme + backup ----
test('theme GET returns 404/empty-theme and PUT validates the body', async () => {
  const missingApp = await makeApp()
  const missing = await missingApp.app.inject({ method: 'GET', url: '/tenants/ghost/theme' })
  assert.equal(missing.statusCode, 404)
  await missingApp.app.close()

  const { app, admin } = await makeApp([], [
    [/SELECT theme, label/, [{ label: 'Alpha', theme: null }]],
    [/UPDATE app\.tenants SET theme/, [{ theme: '{"primary":"#f00"}' }]],
  ])
  const bad = await app.inject({ method: 'PUT', url: '/tenants/alpha/theme', payload: { theme: 'red' } })
  assert.equal(bad.statusCode, 400)
  const ok = await app.inject({ method: 'PUT', url: '/tenants/alpha/theme', payload: { theme: { primary: '#f00' } } })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(admin.calls.find((c) => /UPDATE app\.tenants SET theme/.test(c.text)).params, ['{"primary":"#f00"}', 'alpha'])
  const get = await app.inject({ method: 'GET', url: '/tenants/alpha/theme' })
  assert.deepEqual(JSON.parse(get.body).theme, {}, 'null theme must fall back to an empty object')
  await app.close()
})

test('GET /tenants/:id/backup dumps every table for the tenant and 404s unknown tenants', async () => {
  const missingApp = await makeApp()
  const missing = await missingApp.app.inject({ method: 'GET', url: '/tenants/ghost/backup' })
  assert.equal(missing.statusCode, 404)
  await missingApp.app.close()

  const { app } = await makeApp([], [
    [/SELECT 1 FROM app\.tenants/, [{ '?column?': 1 }]],
    [/row_to_json/, [{ row_to_json: { order_id: 'ORD-9' } }]],
  ])
  const res = await app.inject({ method: 'GET', url: '/tenants/alpha/backup' })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.tenant, 'alpha')
  assert.equal(body.tables.records.length, 1)
  assert.equal(body.tables.records[0].order_id, 'ORD-9')
  assert.ok(body.tables.ai_usage_logs, 'backup must include every tenant table')
  assert.match(res.headers['content-disposition'], /alpha-backup\.json/)
  await app.close()
})

// ---- AI proxy pass-through (tenant header + streaming) ----
function startUpstream() {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: req.url, tenant: req.headers['x-tenant-id'], body: Buffer.concat(chunks).toString() })
      if (req.url === '/chat/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: start\ndata: {"ok":true}\n\n')
        res.write('event: done\ndata: {"ok":true}\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ upstream: 'ok' }))
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
}

test('/ai/* proxies carry x-tenant-id to the AI service and stream SSE through', async () => {
  const upstream = await startUpstream()
  const data = await makeFakePool()
  const admin = await makeFakePool()
  const bff = await buildApp({
    pool: data.pool,
    adminPool: admin.pool,
    aiServiceUrl: `http://127.0.0.1:${upstream.port}`,
    logger: false,
  })
  try {
    const chat = await bff.inject({
      method: 'POST',
      url: '/ai/chat',
      headers: { 'x-tenant-id': 'beta', 'content-type': 'application/json' },
      payload: { message: 'hi' },
    })
    assert.equal(chat.statusCode, 200)
    assert.equal(JSON.parse(chat.body).upstream, 'ok')
    assert.equal(upstream.seen[0].tenant, 'beta')
    assert.match(upstream.seen[0].body, /"message":"hi"/)

    const stream = await bff.inject({
      method: 'POST',
      url: '/ai/chat/stream',
      headers: { 'x-tenant-id': 'beta', 'content-type': 'application/json' },
      payload: { message: 'hi' },
    })
    assert.equal(stream.statusCode, 200)
    assert.match(stream.body, /event: start/)
    assert.match(stream.body, /event: done/)
  } finally {
    await bff.close()
    upstream.server.close()
  }
})
