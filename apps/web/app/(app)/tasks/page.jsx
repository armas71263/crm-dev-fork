import { bffFetch } from '../../../src/lib/bff.js'
import DataTable from '../../../components/DataTable.jsx'

// Tasks are activities filtered by type=task (deliberately not a separate
// entity — see migration 004 and the module registry).
const date = (d) => (d ? String(d).slice(0, 10) : '—')

export default async function TasksPage() {
  const { activities } = await bffFetch('/data/crm/activities?type=task')
  const open = activities.filter((a) => !a.completed)
  const done = activities.filter((a) => a.completed)

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Tasks</h1>
        <p className="text-[14px] text-steel mt-1">Open and completed tasks across every deal, company and contact.</p>
      </header>

      <section>
        <h2 className="text-[15px] font-semibold mb-3">Open ({open.length})</h2>
        <DataTable
          rows={open}
          empty="No open tasks."
          columns={[
            { key: 'subject', label: 'Task', render: (r) => <span className="font-medium">{r.subject}</span> },
            { key: 'entity', label: 'Linked to' },
            { key: 'due_at', label: 'Due', render: (r) => date(r.due_at) },
          ]}
        />
      </section>

      <section>
        <h2 className="text-[15px] font-semibold mb-3">Completed ({done.length})</h2>
        <DataTable
          rows={done}
          empty="Nothing completed yet."
          columns={[
            { key: 'subject', label: 'Task' },
            { key: 'entity', label: 'Linked to' },
            { key: 'due_at', label: 'Due', render: (r) => date(r.due_at) },
          ]}
        />
      </section>
    </div>
  )
}
