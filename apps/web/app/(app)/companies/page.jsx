import { bffFetch } from '../../../src/lib/bff.js'
import UrlFilterBar from '../../../components/UrlFilterBar.jsx'
import DataTable from '../../../components/DataTable.jsx'
import StatusDot from '../../../components/StatusDot.jsx'

export default async function CompaniesPage({ searchParams }) {
  const { companies } = await bffFetch('/data/crm/companies')
  // URL-as-state: the filtered view is the link (Phase 6.5)
  const q = String(searchParams?.q || "" ).toLowerCase()
  const status = String(searchParams?.status || "")
  const statuses = [...new Set(companies.map((c) => c.status).filter(Boolean))].sort()
  const rows = companies.filter((c) =>
    (!q || [c.name, c.industry, c.type, c.website].some((v) => String(v || "").toLowerCase().includes(q))) &&
    (!status || c.status === status))
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Companies</h1>
        <p className="text-[14px] text-steel mt-1">Customers, prospects, suppliers and partners.</p>
      </header>
      <UrlFilterBar fields={['name', 'industry', 'type']} statuses={statuses} />
      <DataTable
        rows={rows}
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
