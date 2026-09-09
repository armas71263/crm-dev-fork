import { bffFetch } from '../../../src/lib/bff.js'
import DataTable from '../../../components/DataTable.jsx'
import InviteForm from '../../../components/InviteForm.jsx'

const date = (d) => (d ? new Date(d).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '—')

export default async function UsersPage() {
  const { users } = await bffFetch('/users')
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Users</h1>
        <p className="text-[14px] text-steel mt-1">People with access to this workspace.</p>
      </header>

      <InviteForm />

      <section>
        <h2 className="text-[15px] font-semibold mb-3">Members ({users.length})</h2>
        <DataTable
          rows={users}
          columns={[
            { key: 'display_name', label: 'Name', render: (r) => <span className="font-medium">{r.display_name || '—'}</span> },
            { key: 'role', label: 'Role' },
            { key: 'company_id', label: 'Company scope', render: (r) => r.company_id || '—' },
            { key: 'created_at', label: 'Added', render: (r) => date(r.created_at) },
          ]}
        />
      </section>
    </div>
  )
}
