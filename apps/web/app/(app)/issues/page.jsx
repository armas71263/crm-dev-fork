import { bffFetch } from '../../../src/lib/bff.js'
import DataTable from '../../../components/DataTable.jsx'
import StatusDot from '../../../components/StatusDot.jsx'
import BarChart from '../../../components/BarChart.jsx'

const TONES = { Open: 'amber', Investigating: 'amber', Resolved: 'green' }

export default async function IssuesPage() {
  const { issues, mix } = await bffFetch('/data/issues')
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Issues</h1>
        <p className="text-[14px] text-steel mt-1">Quality tickets across orders and shipments.</p>
      </header>

      {mix?.length > 0 && (
        <div className="border border-line bg-white p-5">
          <h2 className="text-[15px] font-semibold mb-4">Open by category</h2>
          <BarChart labels={mix.map((m) => m.category)} values={mix.map((m) => m.value)} />
        </div>
      )}

      <DataTable
        rows={issues}
        columns={[
          { key: 'ticket_id', label: 'Ticket', render: (r) => <span className="font-medium">{r.ticket_id}</span> },
          { key: 'category', label: 'Category' },
          { key: 'description', label: 'Description' },
          { key: 'status', label: 'Status', render: (r) => <StatusDot status={r.status} tone={TONES[r.status] || 'gray'} /> },
        ]}
      />
    </div>
  )
}
