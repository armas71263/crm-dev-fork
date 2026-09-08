import { bffFetch } from '../../../src/lib/bff.js'
import DataTable from '../../../components/DataTable.jsx'

export default async function ContactsPage() {
  const { contacts } = await bffFetch('/data/crm/contacts')
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Contacts</h1>
        <p className="text-[14px] text-steel mt-1">People across your companies.</p>
      </header>
      <DataTable
        rows={contacts}
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
