import { bffFetch } from '../../../src/lib/bff.js'
import UrlFilterBar from '../../../components/UrlFilterBar.jsx'
import DataTable from '../../../components/DataTable.jsx'

export default async function ContactsPage({ searchParams }) {
  const { contacts } = await bffFetch('/data/crm/contacts')
  const q = String(searchParams?.q || "").toLowerCase()
  const status = String(searchParams?.status || "")
  const statuses = [...new Set(contacts.map((c) => c.status).filter(Boolean))].sort()
  const rows = contacts.filter((c) =>
    (!q || [c.full_name, c.title, c.email].some((v) => String(v || "").toLowerCase().includes(q))) &&
    (!status || c.status === status))
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Contacts</h1>
        <p className="text-[14px] text-steel mt-1">People across your companies.</p>
      </header>
      <UrlFilterBar fields={['name', 'title', 'email']} statuses={statuses} />
      <DataTable
        rows={rows}
        columns={[
          { key: 'full_name', label: 'Name', render: (r) => <span className="font-medium">{r.full_name}</span> },
          { key: 'title', label: 'Title' },
          { key: 'email', label: 'Email' },
          { key: 'phone', label: 'Phone' },
          { key: 'status', label: 'Status' },
        ]}
      />
    </div>
  )
}
