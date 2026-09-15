import { createClient } from '../../../../src/lib/supabase/server.js'

export const dynamic = 'force-dynamic'

// Same-origin proxy: triggers a forecast job on the predictions service with
// the verified session JWT. The BFF scopes everything to the caller's tenant.
export async function POST(request) {
  const supabase = createClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return new Response('unauthenticated', { status: 401 })

  const body = await request.text()
  const res = await fetch(`${process.env.NEXT_PUBLIC_BFF_URL}/data/forecast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body,
  })
  if (!res.ok) return new Response(`upstream ${res.status}`, { status: res.status })
  return new Response(await res.text(), { headers: { 'content-type': 'application/json' } })
}
