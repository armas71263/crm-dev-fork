import { createClient } from '../../../../src/lib/supabase/server.js'

export const dynamic = 'force-dynamic'

// Same-origin proxy for the dashboard's "Ask the data" card: a natural-language
// question answered by the assistant (text-to-SQL + tools), JWT attached.
export async function POST(request) {
  const supabase = createClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return new Response('unauthenticated', { status: 401 })

  const body = await request.text()
  const res = await fetch(`${process.env.NEXT_PUBLIC_BFF_URL}/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body,
  })
  if (!res.ok) return new Response(`upstream ${res.status}`, { status: res.status })
  return new Response(await res.text(), { headers: { 'content-type': 'application/json' } })
}
