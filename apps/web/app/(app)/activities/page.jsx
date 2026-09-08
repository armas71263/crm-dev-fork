import { bffFetch } from '../../../src/lib/bff.js'
import DataTable from '../../../components/DataTable.jsx'
import StatusDot from '../../../components/StatusDot.jsx'

const TYPE_TONES = { call: 'green', email: 'gray', meeting: 'amber', task: 'amber', note: 'gray' }

export default async function ActivitiesPage() {
  const { activities } = await bffFetch('/data/crm/activities')
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Activities</h1>
        <p className="text-[14px] text-steel mt-1">Calls, meetings, tasks and notes.</p>
      </header>
      <DataTable
        rows={activities}
        columns={[
          { key: 'subject', label: 'Subject', render: (r) => <span className="font-medium">{r.subject}</span> },
          { key: 'type', label: 'Type', render: (r) => <StatusDot status={r.type} tone={TYPE_TONES[r.type] || 'gray'} /> },
          { key: 'detail', label: 'Detail', render: (r) => <span className="text-steel">{r.detail || '—'}</span> },
          {
            key: 'completed', label: 'Done',
            render: (r) => r.completed ? 'Yes' : 'No',
          },
        ]}
      />
    </div>
  )
}
