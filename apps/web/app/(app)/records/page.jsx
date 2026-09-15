import { bffFetch } from '../../../src/lib/bff.js'
import DataTable from '../../../components/DataTable.jsx'
import StatusDot from '../../../components/StatusDot.jsx'

const TONES = { Open: 'green', 'In Production': 'amber', Shipped: 'amber', Delivered: 'gray' }

export default async function RecordsPage() {
  const { orders } = await bffFetch('/data/orders')
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Order records</h1>
        <p className="text-[14px] text-steel mt-1">The template trade module — orders, grades and shipments.</p>
      </header>
      <DataTable
        rows={orders}
        columns={[
          { key: 'order_id', label: 'Order', render: (r) => <span className="font-medium">{r.order_id}</span> },
          { key: 'customer', label: 'Customer' },
          { key: 'supplier', label: 'Supplier' },
          { key: 'grade', label: 'Grade' },
          { key: 'mt', label: 'MT', render: (r) => <span className="text-right block">{r.mt}</span> },
          { key: 'fcl', label: 'FCL', render: (r) => <span className="text-right block">{r.fcl}</span> },
          { key: 'price_usd', label: 'USD/MT', render: (r) => <span className="text-right block">{r.price_usd}</span> },
          { key: 'status', label: 'Status', render: (r) => <StatusDot status={r.status} tone={TONES[r.status] || 'gray'} /> },
        ]}
      />
    </div>
  )
}
