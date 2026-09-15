import { bffFetch } from '../../../src/lib/bff.js'
import DataTable from '../../../components/DataTable.jsx'

export default async function CustomersPage() {
  const { parties } = await bffFetch('/data/parties?full=1')
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Customers</h1>
        <p className="text-[14px] text-steel mt-1">Who we sell to.</p>
      </header>
      <DataTable
        rows={parties.filter((p) => p.type === 'customer')}
        empty="No customers yet."
        columns={[
          { key: 'name', label: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
          { key: 'type', label: 'Type' },
          { key: 'contact', label: 'Contact', render: (r) => (r.contact?.name ? `${r.contact.name}${r.contact.phone ? ' · ' + r.contact.phone : ''}` : '—') },
          { key: 'tags', label: 'Tags', render: (r) => (Array.isArray(r.tags) && r.tags.length ? r.tags.join(', ') : '—') },
        ]}
      />
    </div>
  )
}
