import { createClient } from './supabase/server.js'

// Same-origin BFF proxy for browser calls: attaches the verified session JWT.
// Thin by design — all auth/tenant scoping happens in the BFF. An EMPTY body
// is forwarded as no body (Fastify rejects empty bodies with a JSON content-type).
export async function bffProxy(request, path, { method, body } = {}) {
  const supabase = createClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return new Response('unauthenticated', { status: 401 })

  const m = method || request.method
  let payload = body !== undefined ? JSON.stringify(body) : undefined
  if (payload === undefined && m !== 'GET') {
    const raw = await request.text()
    if (raw) payload = raw
  }
  const headers = { authorization: `Bearer ${session.access_token}` }
  if (payload !== undefined) headers['content-type'] = 'application/json'

  const res = await fetch(`${process.env.NEXT_PUBLIC_BFF_URL}${path}`, {
    method: m,
    headers,
    body: payload,
  })
  if (!res.ok) return new Response(`upstream ${res.status}`, { status: res.status })
  return new Response(await res.text(), { headers: { 'content-type': 'application/json' } })
}
