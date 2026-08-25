// Tenant onboarding helper (Directus SDK)
import { createDirectus, rest, authentication } from '@directus/sdk'
import fs from 'fs'

const DIRECTUS = createDirectus(process.env.DIRECTUS_URL || 'http://localhost:8055').with(rest()).with(authentication())

async function login() {
  await DIRECTUS.login({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
}

/**
 * Create tenant + clone template + roles + presets
 * argv: tenantName --template=rubbertrack
 */
export async function onboard(tenantName, { template = 'rubbertrack', seed = true } = {}) {
  await login()
  const payload = JSON.parse(fs.readFileSync(`infra/templates/${template}.json`, 'utf8'))

  // 1) Create tenant record (directus_users model: tenants)
  const tenants = DIRECTUS.collection('tenants')
  await tenants.create({ name: tenantName })

  // 2) Apply template collections
  for (const [name, def] of Object.entries(payload.collections)) {
    await DIRECTUS.collection(name).create(def)
    // add RLS policy reference
  }

  // 3) Create roles
  const roles = DIRECTUS.role('roles')
  const rolesToCreate = ['tenant-admin', 'staff-sales', 'staff-logistics', 'staff-documentation', 'staff-technical', 'customer']
  for (const r of rolesToCreate) {
    await roles.create({ name: r, type: 'role', tenant: tenantName })
  }

  // 4) Apply permission presets (rooted to tenant)
  // TODO: presets in v2

  if (seed) await seedSample(tenantName, template)
  return { tenant: tenantName, template, seeded: seed }
}

async function seedSample(tenantName, template) {
  if (template === 'rubbertrack') {
    const records = [
      { order_id: 'ORD-2026-0039', date: '2026-08-01', customer: 'BKT', supplier: 'Lexley Rubber', grade: 'T30M', mt: 50.4, fcl: 2, price_usd: 2240 },
      { order_id: 'ORD-2026-0042', date: '2026-08-10', customer: 'JK Tyre', supplier: 'Tiong Huat', grade: 'TSR-20', mt: 100.8, fcl: 4, price_usd: 1875 },
    ]
    // ...
  }
}
