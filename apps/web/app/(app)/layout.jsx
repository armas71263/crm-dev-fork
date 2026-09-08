import { createClient } from '../../src/lib/supabase/server.js'
import { sectionsForRole } from '../../src/lib/bff.js'
import NavRail from '../../components/NavRail.jsx'

export default async function AppLayout({ children }) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: { user: meta } } = await supabase.auth.getUser()
  const role = meta?.app_metadata?.role || 'staff'

  return (
    <div className="flex min-h-screen">
      <NavRail sections={sectionsForRole(role)} userEmail={user.email} />
      <main className="flex-1 px-8 py-8 max-w-6xl">{children}</main>
    </div>
  )
}
