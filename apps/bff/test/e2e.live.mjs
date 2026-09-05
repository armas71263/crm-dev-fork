import fs from 'fs'
import { spawn } from 'child_process'

// Live end-to-end auth test — runs against the REAL Supabase project from ../../.env.
// Not part of `npm test` (which is unit-level): run manually with  node test/e2e.live.mjs
// Requires the three test users created via the Auth Admin API (see AGENTS.md):
//   staff.rt@test.dev  (rubbertrack, tenant-admin)   password: LIVE_E2E_PASSWORD
//   staff.lex@test.dev (lexley, tenant-admin)        password: LIVE_E2E_PASSWORD
//   cust.ceat@test.dev (rubbertrack, CEAT, customer) password: LIVE_E2E_PASSWORD
// Exits non-zero on any failure. Verifies: real JWT verification, cross-tenant
// isolation, customer company isolation, and 401 fail-closed paths.

const env = { ...process.env }
for (const line of fs.readFileSync('../../.env', 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2]
}
const PASSWORD = env.LIVE_E2E_PASSWORD || 'TestPass123!'
let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

async function login(email) {
  const res = await fetch(env.SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const d = await res.json()
  if (!d.access_token) throw new Error('login failed for ' + email + ': ' + JSON.stringify(d).slice(0, 200))
  return d.access_token
}

const bff = spawn('node', ['src/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
const bfflog = []
bff.stdout.on('data', (d) => bfflog.push(d.toString()))
bff.stderr.on('data', (d) => bfflog.push(d.toString()))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  const base = 'http://127.0.0.1:4000'
  let up = false
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) { up = true; break } } catch {}
    await wait(250)
  }
  check('BFF boots in JWT mode', up, up ? '' : bfflog.join('').slice(0, 300))
  if (!up) process.exit(1)

  const [rt, lex, cust] = await Promise.all([
    login('staff.rt@test.dev'), login('staff.lex@test.dev'), login('cust.ceat@test.dev'),
  ])
  const get = async (path, token) => {
    const res = await fetch(base + path, token ? { headers: { authorization: 'Bearer ' + token } } : {})
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  const r1 = await get('/data/orders', rt)
  check('rubbertrack staff sees own tenant (7 orders)', r1.status === 200 && r1.body.orders?.length === 7, `got ${r1.body?.orders?.length}`)
  const r2 = await get('/data/orders', lex)
  check('lexley staff sees ONLY lexley (1 order)', r2.status === 200 && r2.body.orders?.length === 1 && r2.body.orders[0].order_id === 'LEX-2026-0001', `got ${r2.body?.orders?.map((o) => o.order_id).join(',')}`)
  const r3 = await get('/data/orders', cust)
  const ceatOk = r3.status === 200 && r3.body.orders?.length === 1 && r3.body.orders.every((o) => o.customer === 'CEAT')
  check('CEAT customer sees only own company orders', ceatOk, `got ${r3.body?.orders?.map((o) => o.order_id + ':' + o.customer).join(',')}`)
  const r4 = await get('/data/orders')
  check('no token is 401', r4.status === 401)
  const r5 = await get('/data/orders', 'garbage.token.here')
  check('garbage token is 401', r5.status === 401)
  const tampered = rt.slice(0, -10) + 'AAAAAAAAAA'
  const r6 = await get('/data/orders', tampered)
  check('tampered token is 401', r6.status === 401)
  const spoof = await fetch(base + '/data/orders', { headers: { 'x-tenant-id': 'rubbertrack' } })
  check('spoofed x-tenant-id header is 401', spoof.status === 401)
} finally {
  bff.kill('SIGTERM')
  await wait(300)
}
console.log(failed === 0 ? 'ALL LIVE E2E CHECKS PASSED' : failed + ' CHECK(S) FAILED')
process.exit(failed === 0 ? 0 : 1)
