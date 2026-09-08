import { createClient } from '../../../../src/lib/supabase/server.js'

export const dynamic = 'force-dynamic'

// Same-origin proxy for "regenerate insights": attaches the verified session
// JWT, asks the AI service to compute a fresh snapshot.
export async function POST() {
  const supabase = createClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return new Response('unauthenticated', { status: 401 })

  const res = await fetch(`${process.env.NEXT_PUBLIC_BFF_URL}/ai/insights`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body: '{}',
  })
  if (!res.ok) return new Response(`upstream ${res.status}`, { status: res.status })
  return new Response(await res.text(), { headers: { 'content-type': 'application/json' } })
}
