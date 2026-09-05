import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'

// ---- Fake pg pool (same contract as routes.test.js / auth.test.js) ----
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

async function makeApp(dataMatchers = []) {
  const data = makeFakePool(dataMatchers)
  const admin = makeFakePool()
  const app = await buildApp({
    pool: data.pool, adminPool: admin.pool, aiServiceUrl: 'http://127.0.0.1:9', logger: false,
  })
  return { app, data }
}

const H = { 'x-tenant-id': 'rubbertrack' }

// ---- List + filters: parameterized, allowlisted ----
test('GET /data/crm/companies lists with fixed order and tenant session', async () => {
  const { app, data } = await makeApp([[/FROM companies/, [{ id: 1, name: 'CEAT' }]]])
  const res = await app.inject({ method: 'GET', url: '/data/crm/companies', headers: H })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { companies: [{ id: 1, name: 'CEAT' }] })
  const q = data.calls.find((c) => /FROM companies/.test(c.text))
  assert.match(q.text, /ORDER BY name/)
  await app.close()
})

test('search filter is parameterized ILIKE — injection-shaped input stays a param', async () => {
  const { app, data } = await makeApp([[/FROM companies/, []]])
  const res = await app.inject({
    method: 'GET', url: '/data/crm/companies?search=' + encodeURIComponent("'; DROP TABLE companies;--"),
    headers: H,
  })
  assert.equal(res.statusCode, 200)
  const q = data.calls.find((c) => /FROM companies/.test(c.text))
  assert.match(q.text, /name ILIKE \$1/)
  assert.ok(q.params.some((p) => String(p).includes('DROP TABLE')), 'the payload must travel as a parameter, never as SQL text')
  assert.doesNotMatch(q.text, /DROP TABLE/)
  await app.close()
})

test('GET /data/crm/deals?stage= filters through a parameterized allowlisted column', async () => {
  const { app, data } = await makeApp([[/FROM deals/, [{ id: 1, name: 'D1' }]]])
  const res = await app.inject({ method: 'GET', url: '/data/crm/deals?stage=won', headers: H })
  assert.equal(res.statusCode, 200)
  const q = data.calls.find((c) => /FROM deals/.test(c.text))
  assert.match(q.text, /stage = \$1/)
  assert.deepEqual(q.params, ['won'])
  await app.close()
})

test('GET /data/crm/activities?type=task powers the Tasks view', async () => {
  const { app, data } = await makeApp([[/FROM activities/, [{ id: 1, subject: 'S' }]]])
  const res = await app.inject({ method: 'GET', url: '/data/crm/activities?type=task', headers: H })
  assert.equal(res.statusCode, 200)
  const q = data.calls.find((c) => /FROM activities/.test(c.text))
  assert.match(q.text, /type = \$1/)
  await app.close()
})

// ---- Create: allowlist only, tenant from session, audit trail ----
test('POST /data/crm/companies inserts with tenant from the session, never the body', async () => {
  const { app, data } = await makeApp([[/RETURNING \*/i, [{ id: 9, name: 'Acme' }]]])
  const res = await app.inject({
    method: 'POST', url: '/data/crm/companies', headers: { ...H, 'content-type': 'application/json' },
    payload: { name: 'Acme', type: 'prospect', tenant_id: 'lexley', evil: 'DROP TABLE companies' },
  })
  assert.equal(res.statusCode, 201)
  assert.equal(JSON.parse(res.body).company.name, 'Acme')
  const ins = data.calls.find((c) => /INSERT INTO companies/.test(c.text))
  assert.match(ins.text, /app\.current_tenant\(\)/, 'tenant must come from the RLS session')
  assert.doesNotMatch(ins.text, /tenant_id.{0,20}\$\d/, 'client-supplied tenant_id must not be an insert column')
  assert.doesNotMatch(ins.text, /evil/i, 'unknown fields must never reach SQL')
  const audit = data.calls.find((c) => /INSERT INTO audit_logs/.test(c.text))
  assert.ok(audit, 'mutations must write audit_logs')
  await app.close()
})

test('POST without a required field is 400', async () => {
  const { app } = await makeApp()
  const res = await app.inject({
    method: 'POST', url: '/data/crm/companies', headers: { ...H, 'content-type': 'application/json' },
    payload: { type: 'prospect' },
  })
  assert.equal(res.statusCode, 400)
  await app.close()
})

test('POST /data/crm/deals requires a stage and inserts it', async () => {
  const { app, data } = await makeApp([[/RETURNING \*/i, [{ id: 5, name: 'D', stage: 'new' }]]])
  const res = await app.inject({
    method: 'POST', url: '/data/crm/deals', headers: { ...H, 'content-type': 'application/json' },
    payload: { name: 'D', stage: 'new', value: 1000 },
  })
  assert.equal(res.statusCode, 201)
  const ins = data.calls.find((c) => /INSERT INTO deals/.test(c.text))
  assert.match(ins.text, /stage/)
  await app.close()
})

// ---- Update/Delete: cross-tenant ids simply match 0 rows → 404 (RLS) ----
test('PATCH updates allowlisted fields only and 404s when no row matches', async () => {
  const missing = await makeApp([[/UPDATE companies/, []]])
  const r404 = await missing.app.inject({
    method: 'PATCH', url: '/data/crm/companies/999', headers: { ...H, 'content-type': 'application/json' },
    payload: { name: 'X', hacked: '1' },
  })
  assert.equal(r404.statusCode, 404)
  await missing.app.close()

  const { app, data } = await makeApp([[/UPDATE companies/, [{ id: 9, name: 'X' }]]])
  const res = await app.inject({
    method: 'PATCH', url: '/data/crm/companies/9', headers: { ...H, 'content-type': 'application/json' },
    payload: { name: 'X', hacked: '1' },
  })
  assert.equal(res.statusCode, 200)
  const upd = data.calls.find((c) => /UPDATE companies/.test(c.text))
  assert.match(upd.text, /WHERE id = \$\d+/)
  assert.doesNotMatch(upd.text, /hacked/i)
  await app.close()
})

test('DELETE removes by id and 404s when nothing matched', async () => {
  const missing = await makeApp([[/DELETE FROM companies/, []]])
  const r404 = await missing.app.inject({ method: 'DELETE', url: '/data/crm/companies/1', headers: H })
  assert.equal(r404.statusCode, 404)
  await missing.app.close()

  const { app, data } = await makeApp([[/DELETE FROM companies/, [{ id: 1 }]]])
  const res = await app.inject({ method: 'DELETE', url: '/data/crm/companies/1', headers: H })
  assert.equal(res.statusCode, 200)
  const del = data.calls.find((c) => /DELETE FROM companies/.test(c.text))
  assert.match(del.text, /WHERE id = \$1/)
  assert.ok(data.calls.some((c) => /INSERT INTO audit_logs/.test(c.text)))
  await app.close()
})

// ---- Pipeline config ----
test('PUT /data/crm/pipeline replaces the tenant stage set', async () => {
  const { app, data } = await makeApp([[/FROM pipeline_stages ORDER BY/, [{ key: 'new', label: 'New' }]]])
  const res = await app.inject({
    method: 'PUT', url: '/data/crm/pipeline', headers: { ...H, 'content-type': 'application/json' },
    payload: [{ key: 'new', label: 'New', position: 1, probability: 10, stage_type: 'open' }],
  })
  assert.equal(res.statusCode, 200)
  const del = data.calls.find((c) => /DELETE FROM pipeline_stages/.test(c.text))
  assert.match(del.text, /app\.current_tenant\(\)/, 'delete must stay tenant-scoped')
  const ins = data.calls.find((c) => /INSERT INTO pipeline_stages/.test(c.text))
  assert.match(ins.text, /app\.current_tenant\(\)/)
  await app.close()
})

test('PUT /data/crm/pipeline with a malformed body is 400', async () => {
  const { app } = await makeApp()
  const res = await app.inject({
    method: 'PUT', url: '/data/crm/pipeline', headers: { ...H, 'content-type': 'application/json' },
    payload: { not: 'an array' },
  })
  assert.equal(res.statusCode, 400)
  const res2 = await app.inject({
    method: 'PUT', url: '/data/crm/pipeline', headers: { ...H, 'content-type': 'application/json' },
    payload: [{ label: 'no key' }],
  })
  assert.equal(res2.statusCode, 400)
  await app.close()
})
