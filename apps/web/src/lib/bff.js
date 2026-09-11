import { createClient } from './supabase/server.js'

// Server-side fetch against the BFF with the user's Supabase JWT. The BFF
// verifies the token and scopes every query via RLS — the frontend never
// selects a tenant itself.
export async function bffFetch(path) {
  const supabase = createClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('unauthenticated')

  const res = await fetch(`${process.env.NEXT_PUBLIC_BFF_URL}${path}`, {
    headers: { authorization: `Bearer ${session.access_token}` },
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`BFF ${path} -> ${res.status}`)
  }
  return res.json()
}

// Map BFF/user role to the nav sections this user should see. Customers get
// the portal-facing subset; staff see the CRM + AI surfaces, plus the vertical
// (template) screens when the tenant actually holds vertical rows. The tenant
// registry is vendor-only.
export function sectionsForRole(role, { vertical = false } = {}) {
  if (role === 'customer') {
    return [
      { href: '/portal', label: 'Overview' },
      { href: '/companies', label: 'Our account' },
    ]
  }
  const sections = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/assistant', label: 'Assistant' },
    { href: '/insights', label: 'Insights' },
    { href: '/suggestions', label: 'Suggestions' },
    { href: '/search', label: 'Search' },
    { href: '/companies', label: 'Companies' },
    { href: '/contacts', label: 'Contacts' },
    { href: '/leads', label: 'Leads' },
    { href: '/deals', label: 'Deals' },
    { href: '/activities', label: 'Activities' },
    { href: '/tasks', label: 'Tasks' },
  ]
  if (vertical) {
    sections.push(
      { href: '/records', label: 'Order records' },
      { href: '/suppliers', label: 'Suppliers' },
      { href: '/customers', label: 'Customers' },
      { href: '/issues', label: 'Issues' },
      { href: '/news', label: 'News feed' },
      { href: '/attendance', label: 'Attendance' },
      { href: '/checklists', label: 'Checklists' },
    )
  }
  sections.push(
    { href: '/screen-config', label: 'Screen config' },
    { href: '/branding', label: 'Branding' },
    { href: '/users', label: 'Users' },
  )
  if (role === 'vendor') sections.push({ href: '/tenants', label: 'Tenants' })
  sections.push({ href: '/usage', label: 'AI usage' })
  return sections
}
