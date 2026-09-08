import { bffFetch } from '../../../src/lib/bff.js'
import DataTable from '../../../components/DataTable.jsx'
import StatusDot from '../../../components/StatusDot.jsx'

const LEAD_TONES = { new: 'gray', working: 'amber', qualified: 'green', converted: 'green', unqualified: 'red' }

export default async function LeadsPage() {
  const { leads } = await bffFetch('/data/crm/leads')
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Leads</h1>
        <p className="text-[14px] text-steel mt-1">Potential business before it becomes a deal.</p>
      </header>
      <DataTable
        rows={leads}
        columns={[
          { key: 'name', label: 'Lead', render: (r) => <span className="font-medium">{r.name}</span> },
          { key: 'company_name', label: 'Company' },
          { key: 'source', label: 'Source' },
          {
            key: 'value', label: 'Value',
            render: (r) => r.value != null ? `$${Number(r.value).toLocaleString()}` : '—',
          },
          { key: 'status', label: 'Status', render: (r) => <StatusDot status={r.status} tone={LEAD_TONES[r.status] || 'gray'} /> },
        ]}
      />
    </div>
  )
}
