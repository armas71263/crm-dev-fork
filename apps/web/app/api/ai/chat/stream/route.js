import { createClient } from '../../../../../src/lib/supabase/server.js'

export const dynamic = 'force-dynamic'

// Same-origin SSE proxy: the browser EventSource/fetch cannot hold the
// Supabase JWT itself, so this route handler attaches the verified session
// token and pipes the BFF's event stream through unchanged.
export async function POST(request) {
  const supabase = createClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return new Response('unauthenticated', { status: 401 })

  const body = await request.text()
  const res = await fetch(`${process.env.NEXT_PUBLIC_BFF_URL}/ai/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body,
  })
  if (!res.ok) return new Response(`upstream ${res.status}`, { status: res.status })

  return new Response(res.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
