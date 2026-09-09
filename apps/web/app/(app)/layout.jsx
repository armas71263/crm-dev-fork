import { createClient } from '../../src/lib/supabase/server.js'
import { bffFetch, sectionsForRole } from '../../src/lib/bff.js'
import NavRail from '../../components/NavRail.jsx'

export default async function AppLayout({ children }) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const role = user.app_metadata?.role || 'staff'

  // Vertical (template) screens show only when the tenant holds vertical rows;
  // the theme drives white-label chrome. Customers skip both (their nav is
  // portal-only and /data/* capability endpoints are staff-gated).
  let vertical = false
  let theme = {}
  let label = null
  if (role !== 'customer') {
    try {
      const [modules, branding] = await Promise.all([
        bffFetch('/data/modules'),
        bffFetch('/data/theme'),
      ])
      vertical = Boolean(modules.vertical)
      theme = branding.theme || {}
      label = branding.label
    } catch {
      // Nav degrades to CRM-only with default branding — never blocks the app.
    }
  }

  return (
    <div className="flex min-h-screen">
      <NavRail
        sections={sectionsForRole(role, { vertical })}
        userEmail={user.email}
        brand={theme.logoText || label || 'RubberTrack'}
        accent={theme.accent}
      />
      <main className="flex-1 px-8 py-8 max-w-6xl">{children}</main>
    </div>
  )
}
