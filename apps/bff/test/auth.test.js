import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { SignJWT, exportJWK } from 'jose'
import { buildApp, createAuthVerifier } from '../src/app.js'

// ---- Test identity: a real ES256 keypair so verification is exercised end-to-end ----
const SUPABASE_URL = 'https://test-project.supabase.co'
const ISSUER = `${SUPABASE_URL}/auth/v1`
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const JWKS = { keys: [await exportJWK(publicKey)] }

async function signToken(claims, { expiresIn = '1h', key = privateKey } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setExpirationTime(expiresIn)
    .sign(key)
}

const staffToken = () => signToken({ sub: 'user-1', app_metadata: { tenant_id: 'lexley', role: 'tenant-admin' } })
const customerToken = () => signToken({
  sub: 'user-2',
  app_metadata: { tenant_id: 'lexley', company_id: 'CEAT', role: 'customer' },
})

// ---- Fake pg pool (same contract as routes.test.js) ----
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

async function makeAuthApp(matchers = [], { customerMatchers } = {}) {
  const data = makeFakePool(matchers)
  const customer = customerMatchers ? makeFakePool(customerMatchers) : null
  const admin = makeFakePool()
  const app = await buildApp({
    pool: data.pool,
    customerPool: customer ? customer.pool : undefined,
    adminPool: admin.pool,
    aiServiceUrl: 'http://127.0.0.1:9',
    logger: false,
    auth: createAuthVerifier({ supabaseUrl: SUPABASE_URL, jwks: JWKS }),
  })
  return { app, data, admin, customer, released: data.released }
}

const bearer = (t) => ({ authorization: `Bearer ${t}` })

// ---- Public surface ----
test('GET /health stays public (no token required)', async () => {
  const { app } = await makeAuthApp()
  const res = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(res.statusCode, 200)
  await app.close()
})

// ---- Fail-closed defaults ----
test('data endpoints without a token are 401 — no default tenant', async () => {
  const { app } = await makeAuthApp()
  const res = await app.inject({ method: 'GET', url: '/data/orders' })
  assert.equal(res.statusCode, 401)
  assert.equal(JSON.parse(res.body).error, 'unauthorized')
  await app.close()
})

test('a token missing app_metadata.tenant_id is 401 — fail-closed, never a fallback tenant', async () => {
  const { app } = await makeAuthApp()
  const token = await signToken({ sub: 'user-3' }) // no app_metadata
  const res = await app.inject({ method: 'GET', url: '/data/orders', headers: bearer(token) })
  assert.equal(res.statusCode, 401)
  await app.close()
})

test('an expired token is 401', async () => {
  const { app } = await makeAuthApp()
  const token = await signToken(
    { sub: 'user-1', app_metadata: { tenant_id: 'lexley', role: 'tenant-admin' } },
    { expiresIn: '-1s' },
  )
  const res = await app.inject({ method: 'GET', url: '/data/orders', headers: bearer(token) })
  assert.equal(res.statusCode, 401)
  await app.close()
})

test('a token signed by a different key is 401', async () => {
  const { app } = await makeAuthApp()
  const attacker = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
  const token = await signToken(
    { sub: 'user-1', app_metadata: { tenant_id: 'lexley', role: 'tenant-admin' } },
    { key: attacker },
  )
  const res = await app.inject({ method: 'GET', url: '/data/orders', headers: bearer(token) })
  assert.equal(res.statusCode, 401)
  await app.close()
})

test('a malformed Authorization header is 401', async () => {
  const { app } = await makeAuthApp()
  const res = await app.inject({ method: 'GET', url: '/data/orders', headers: { authorization: 'Basic zzz' } })
  assert.equal(res.statusCode, 401)
  await app.close()
})

// ---- Tenant scoping comes from the verified token, never the client ----
test('a valid staff JWT scopes the RLS session to the JWT tenant and ignores x-tenant-id', async () => {
  const { app, data } = await makeAuthApp([[/FROM records ORDER BY created_at/, [{ order_id: 'LEX-1' }]]])
  const token = await staffToken()
  const res = await app.inject({
    method: 'GET',
    url: '/data/orders',
    headers: { ...bearer(token), 'x-tenant-id': 'rubbertrack' }, // spoofed header must be ignored
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { orders: [{ order_id: 'LEX-1' }] })
  const setCall = data.calls.find((c) => /set_config\('app\.tenant_id'/.test(c.text))
  assert.deepEqual(setCall.params, ['lexley'], 'tenant must come from the verified JWT, not the header')
  assert.ok(data.calls.some((c) => c.text === 'RESET app.tenant_id'))
  await app.close()
})

// ---- Customer role: separate app_customer pool, company GUC, no SET ROLE ----
test('a customer JWT runs on the customer pool with the company GUC — staff pool untouched', async () => {
  const { app, data, customer } = await makeAuthApp(
    [],
    { customerMatchers: [[/FROM records ORDER BY created_at/, [{ order_id: 'CEAT-1' }]]] },
  )
  const token = await customerToken()
  const res = await app.inject({ method: 'GET', url: '/data/orders', headers: bearer(token) })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { orders: [{ order_id: 'CEAT-1' }] })
  assert.equal(data.calls.length, 0, 'customer requests must never touch the staff (app_role) pool')
  const texts = customer.calls.map((c) => c.text)
  const setTenant = texts.findIndex((t) => /set_config\('app\.tenant_id'/.test(t))
  const setCompany = texts.findIndex((t) => /set_config\('app\.company_id'/.test(t))
  const query = texts.findIndex((t) => /FROM records/.test(t))
  assert.ok(setTenant >= 0 && setCompany >= 0, 'tenant and company context must both be set')
  assert.ok(setTenant < setCompany && setCompany < query, 'context must be set before the query runs')
  assert.deepEqual(customer.calls[setCompany].params, ['CEAT'])
  assert.ok(!texts.includes('SET ROLE app_customer'), 'pool-per-role, never SET ROLE (see migration 003)')
  assert.ok(texts.includes('RESET app.company_id'), 'company GUC must be reset before release')
  assert.ok(texts.includes('RESET app.tenant_id'))
  assert.equal(customer.released.length, 1)
  await app.close()
})

test('a customer token without a configured customer pool is 503 — fail closed, never staff scope', async () => {
  const { app, data } = await makeAuthApp() // no customerMatchers → no customerPool
  const token = await customerToken()
  const res = await app.inject({ method: 'GET', url: '/data/orders', headers: bearer(token) })
  assert.equal(res.statusCode, 503)
  assert.equal(data.calls.length, 0, 'a misconfigured customer path must not fall back to the staff pool')
  await app.close()
})

test('a staff JWT stays on the staff pool with full tenant scope', async () => {
  const { app, data, customer } = await makeAuthApp(
    [[/FROM records ORDER BY created_at/, [{ order_id: 'LEX-1' }]]],
    { customerMatchers: [] },
  )
  const token = await staffToken()
  const res = await app.inject({ method: 'GET', url: '/data/orders', headers: bearer(token) })
  assert.equal(res.statusCode, 200)
  assert.equal(customer.calls.length, 0, 'staff requests never touch the customer pool')
  assert.ok(data.calls.some((c) => /FROM records/.test(c.text)))
  assert.ok(!data.calls.some((c) => /app\.company_id/.test(c.text)), 'no company GUC for staff')
  await app.close()
})

// ---- Dev mode stays explicit: no verifier → legacy header behavior (local dev only) ----
test('without an auth verifier the BFF runs in explicit dev mode (x-tenant-id allowed)', async () => {
  const data = makeFakePool()
  const admin = makeFakePool()
  const app = await buildApp({
    pool: data.pool, adminPool: admin.pool, aiServiceUrl: 'http://127.0.0.1:9', logger: false,
  })
  const res = await app.inject({ method: 'GET', url: '/data/orders', headers: { 'x-tenant-id': 'beta' } })
  assert.equal(res.statusCode, 200)
  const setCall = data.calls.find((c) => /set_config\('app\.tenant_id'/.test(c.text))
  assert.deepEqual(setCall.params, ['beta'])
  await app.close()
})
