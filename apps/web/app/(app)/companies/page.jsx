import { bffFetch } from '../../../src/lib/bff.js'
import DataTable from '../../../components/DataTable.jsx'
import StatusDot from '../../../components/StatusDot.jsx'

export default async function CompaniesPage() {
  const { companies } = await bffFetch('/data/crm/companies')
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Companies</h1>
        <p className="text-[14px] text-steel mt-1">Customers, prospects, suppliers and partners.</p>
      </header>
      <DataTable
        rows={companies}
        columns={[
          { key: 'name', label: 'Company', render: (r) => <span className="font-medium">{r.name}</span> },
          { key: 'type', label: 'Type' },
          { key: 'industry', label: 'Industry' },
          { key: 'phone', label: 'Phone' },
          { key: 'status', label: 'Status', render: (r) => <StatusDot status={r.status} tone="green" /> },
        ]}
      />
    </div>
  )
}
