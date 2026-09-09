import { createClient } from '../../../../../src/lib/supabase/server.js'

export const dynamic = 'force-dynamic'

// Same-origin proxy: invites a user with the verified session JWT. The BFF
// holds the Supabase service key; the browser only ever sees this route.
export async function POST(request) {
  const supabase = createClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return new Response('unauthenticated', { status: 401 })

  const body = await request.text()
  const res = await fetch(`${process.env.NEXT_PUBLIC_BFF_URL}/users/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body,
  })
  if (!res.ok) return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } })
  return new Response(await res.text(), { headers: { 'content-type': 'application/json' } })
}
