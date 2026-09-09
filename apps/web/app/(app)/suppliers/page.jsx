import { bffFetch } from '../../../src/lib/bff.js'
import DataTable from '../../../components/DataTable.jsx'

function PartiesTable({ rows, emptyLabel }) {
  return (
    <DataTable
      rows={rows}
      empty={emptyLabel}
      columns={[
        { key: 'name', label: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
        { key: 'type', label: 'Type' },
        { key: 'contact', label: 'Contact', render: (r) => (r.contact?.name ? `${r.contact.name}${r.contact.phone ? ' · ' + r.contact.phone : ''}` : '—') },
        { key: 'tags', label: 'Tags', render: (r) => (Array.isArray(r.tags) && r.tags.length ? r.tags.join(', ') : '—') },
      ]}
    />
  )
}

export async function PartiesRows() {
  const { parties } = await bffFetch('/data/parties?full=1')
  return parties
}

export default async function SuppliersPage() {
  const parties = await PartiesRows()
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Suppliers</h1>
        <p className="text-[14px] text-steel mt-1">Who we buy from.</p>
      </header>
      <PartiesTable rows={parties.filter((p) => p.type === 'supplier')} emptyLabel="No suppliers yet." />
    </div>
  )
}
