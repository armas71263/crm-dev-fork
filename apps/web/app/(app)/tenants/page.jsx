import { createClient } from '../../../src/lib/supabase/server.js'
import { bffFetch } from '../../../src/lib/bff.js'
import DataTable from '../../../components/DataTable.jsx'
import OnboardForm from '../../../components/OnboardForm.jsx'

const date = (d) => (d ? new Date(d).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '—')

// Vendor control plane: the tenant registry. The BFF 403s this for ordinary
// tenant staff and customers — only the vendor role gets through.
export default async function TenantsPage() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const role = user?.app_metadata?.role || 'staff'
  if (role !== 'vendor') {
    return (
      <div className="space-y-6">
        <h1 className="text-[24px] font-semibold tracking-tight">Tenants</h1>
        <div className="border border-line bg-white px-4 py-6 text-[14px] text-steel">
          The tenant registry is vendor-only. Your role ({role}) does not have access.
        </div>
      </div>
    )
  }

  const { tenants } = await bffFetch('/tenants')
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Tenants</h1>
        <p className="text-[14px] text-steel mt-1">{tenants.length} workspaces on the platform.</p>
      </header>

      <OnboardForm />

      <DataTable
        rows={tenants}
        columns={[
          { key: 'id', label: 'Tenant', render: (r) => <span className="font-medium">{r.id}</span> },
          { key: 'label', label: 'Name' },
          { key: 'template', label: 'Template' },
          { key: 'tier', label: 'Tier' },
          { key: 'status', label: 'Status' },
          { key: 'created_at', label: 'Onboarded', render: (r) => date(r.created_at) },
        ]}
      />
    </div>
  )
}
