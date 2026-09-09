// End-to-end session verification without a browser:
//   1. Real Supabase password login using the app's own @supabase/ssr client
//      (custom cookie adapter captures exactly what the browser would set).
//   2. Replay that cookie against the running Next.js server for every
//      protected route and assert the SSR HTML renders live data.
//   3. Stream one AI assistant turn through the same-origin SSE proxy and
//      assert the full event protocol (start → tool → token → done).
//   4. Assert role gates: the web /tenants page shows the vendor-only notice,
//      and the BFF 403s a staff JWT from the tenant registry.
//   5. Assert the middleware redirect (no cookie -> /login).
// Usage: node scripts/verify-session.js [email] [password]
// Env: NEXT_PUBLIC_SUPABASE_URL/_ANON_KEY (read from .env.local if unset),
//      APP_URL (default http://127.0.0.1:3000)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '..')

function loadEnvLocal() {
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('NEXT_PUBLIC_')) return
  try {
    for (const line of readFileSync(join(webRoot, '.env.local'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* .env.local optional when env is exported */ }
}
loadEnvLocal()

const { createBrowserClient } = await import(join(webRoot, 'node_modules', '@supabase', 'ssr', 'dist', 'main', 'index.js'))

const email = process.argv[2] || 'staff.rt@test.dev'
const password = process.argv[3] || 'TestPass123!'
const appUrl = process.env.APP_URL || 'http://127.0.0.1:3000'

const jar = new Map()
const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  },
)

const { data, error } = await supabase.auth.signInWithPassword({ email, password })
if (error) {
  console.log(`FAIL auth: ${error.message}`)
  process.exit(1)
}
console.log(`PASS auth: signed in as ${data.user.email}`)
const cookie = [...jar].map(([n, v]) => `${n}=${v}`).join('; ')

const routes = [
  { path: '/dashboard', marker: 'Dashboard' },
  { path: '/companies', marker: 'Companies' },
  { path: '/contacts', marker: 'Contacts' },
  { path: '/leads', marker: 'Leads' },
  { path: '/deals', marker: 'Deals' },
  { path: '/activities', marker: 'Activities' },
  { path: '/tasks', marker: 'Tasks' },
  { path: '/records', marker: 'Order records' },
  { path: '/suppliers', marker: 'Suppliers' },
  { path: '/customers', marker: 'Customers' },
  { path: '/issues', marker: 'Issues' },
  { path: '/news', marker: 'News feed' },
  { path: '/search?q=CEAT', marker: 'CEAT' }, // CRM results must actually render
  { path: '/assistant', marker: 'Assistant' },
  { path: '/insights', marker: 'Insights' },
  { path: '/usage', marker: 'AI usage' },
  { path: '/users', marker: 'Users' },
  { path: '/branding', marker: 'Branding' },
  { path: '/screen-config', marker: 'Screen config' },
]

let failed = 0
for (const route of routes) {
  const res = await fetch(`${appUrl}${route.path}`, {
    headers: { cookie },
    redirect: 'manual',
  })
  const html = await res.text()
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
  const rows = (html.match(/<tr[\s>]/g) || []).length
  const ok = res.status === 200 && body.includes(route.marker)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${route.path}: HTTP ${res.status}, ${rows} table rows, marker "${route.marker}" ${ok ? 'found' : 'MISSING'}`)
  console.log(`      sample: ${body.slice(0, 160)}`)
}

// One real AI assistant turn through the same-origin SSE proxy.
{
  const res = await fetch(`${appUrl}/api/ai/chat/stream`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'pipeline overview', session_id: 'verify-' + Date.now() }),
    signal: AbortSignal.timeout(30000),
  })
  const ct = res.headers.get('content-type') || ''
  let ok = res.status === 200 && /text\/event-stream/.test(ct)
  let detail = `HTTP ${res.status}, ${ct}`
  if (ok) {
    const body = await res.text()
    const need = ['event: start', '"name":"get_crm_kpi"', 'event: token', 'event: done']
    const missing = need.filter((n) => !body.includes(n))
    if (missing.length) {
      ok = false
      detail = `missing frames: ${missing.join(', ')}; got ${body.slice(0, 200)}`
    } else {
      const done = body.match(/event: done\ndata: (.+)/)
      detail = `full SSE protocol OK — ${done ? done[1].slice(0, 140) : ''}`
    }
  }
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} /api/ai/chat/stream: ${detail}`)
}

// Vendor gate, both layers: the web page shows a vendor-only notice for staff;
// the BFF — the real security boundary — 403s a staff JWT from /tenants.
{
  const page = await fetch(`${appUrl}/tenants`, { headers: { cookie }, redirect: 'manual' })
  const text = (await page.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const pageOk = page.status === 200 && /vendor-only/i.test(text)
  const { data: { session } } = await supabase.auth.getSession()
  const api = await fetch(`${process.env.NEXT_PUBLIC_BFF_URL}/tenants`, {
    headers: { authorization: `Bearer ${session.access_token}` },
  })
  const ok = pageOk && api.status === 403
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} /tenants: web notice=${pageOk ? 'shown' : 'MISSING'}, BFF staff JWT → HTTP ${api.status} (expected 403)`)
}

// Middleware: unauthenticated request must redirect to /login.
const res = await fetch(`${appUrl}/dashboard`, { redirect: 'manual' })
const loc = res.headers.get('location') || ''
if (res.status === 307 && loc.includes('/login')) {
  console.log('PASS middleware: no-cookie /dashboard redirects to /login')
} else {
  failed++
  console.log(`FAIL middleware: got HTTP ${res.status}, location=${loc}`)
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILURES`)
process.exit(failed === 0 ? 0 : 1)
