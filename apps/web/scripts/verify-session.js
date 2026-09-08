// End-to-end session verification without a browser:
//   1. Real Supabase password login using the app's own @supabase/ssr client
//      (custom cookie adapter captures exactly what the browser would set).
//   2. Replay that cookie against the running Next.js server for every
//      protected route and assert the SSR HTML contains live data.
//   3. Assert the middleware redirect (no cookie -> /login).
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
  '/dashboard', '/companies', '/contacts', '/leads', '/deals', '/activities',
]

let failed = 0
for (const route of routes) {
  const res = await fetch(`${appUrl}${route}`, {
    headers: { cookie },
    redirect: 'manual',
  })
  const html = await res.text()
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
  const rows = (html.match(/<tr[\s>]/g) || []).length
  const ok = res.status === 200 && rows > 0 && body.includes('Dashboard') === false ? false : true
  const status = res.status === 200 && rows > 0 ? 'PASS' : 'FAIL'
  if (status === 'FAIL') failed++
  console.log(`${status} ${route}: HTTP ${res.status}, ${rows} table rows, ${body.length} chars text`)
  console.log(`      sample: ${body.slice(0, 160)}`)
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
