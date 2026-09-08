import { bffFetch } from '../../../src/lib/bff.js'
import DataTable from '../../../components/DataTable.jsx'
import StatusDot, { stageTone } from '../../../components/StatusDot.jsx'

export default async function DealsPage() {
  const [{ deals }, { stages }] = await Promise.all([
    bffFetch('/data/crm/deals'),
    bffFetch('/data/crm/pipeline'),
  ])
  const stageLabel = new Map(stages.map((s) => [s.key, s]))
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Deals</h1>
        <p className="text-[14px] text-steel mt-1">Your pipeline, ordered newest first.</p>
      </header>
      <DataTable
        rows={deals}
        columns={[
          { key: 'name', label: 'Deal', render: (r) => <span className="font-medium">{r.name}</span> },
          {
            key: 'stage', label: 'Stage',
            render: (r) => {
              const st = stageLabel.get(r.stage)
              return <StatusDot status={st?.label || r.stage} tone={stageTone(st?.stage_type)} />
            },
          },
          {
            key: 'value', label: 'Value',
            render: (r) => r.value != null
              ? `$${Number(r.value).toLocaleString()}${r.currency === 'USD' ? '' : ' ' + r.currency}`
              : '—',
          },
          {
            key: 'expected_close_date', label: 'Expected close',
            render: (r) => r.expected_close_date || '—',
          },
          { key: 'status', label: 'Status' },
        ]}
      />
    </div>
  )
}
