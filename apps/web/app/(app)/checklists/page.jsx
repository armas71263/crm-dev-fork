import { bffFetch } from '../../../src/lib/bff.js'

// Checklists: the tenant's active checklist template (party-scoped, JSON).
// Rendered generically so any checklist shape works — arrays of objects become
// an item table, anything else degrades to a definition list.
function ChecklistBody({ checklist }) {
  if (Array.isArray(checklist)) {
    const keys = [...new Set(checklist.flatMap((item) => Object.keys(item || {})))]
    return (
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full datatable border-collapse">
          <thead>
            <tr>{keys.map((k) => <th key={k}>{k}</th>)}</tr>
          </thead>
          <tbody>
            {checklist.map((item, i) => (
              <tr key={i}>
                {keys.map((k) => {
                  const v = item?.[k]
                  const display = typeof v === 'boolean' ? (v ? '✓' : '✗') : (v ?? '—')
                  return <td key={k} className={typeof v === 'boolean' ? (v ? 'text-leaf' : 'text-red-600') : ''}>{String(display)}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  const entries = Object.entries(checklist)
  return (
    <div className="border border-line bg-white divide-y divide-line">
      {entries.map(([k, v]) => (
        <div key={k} className="px-4 py-3 flex gap-4">
          <div className="text-[14px] font-medium w-48 shrink-0">{k}</div>
          <div className="text-[14px] text-steel">{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}</div>
        </div>
      ))}
    </div>
  )
}

export default async function ChecklistsPage() {
  const { checklist } = await bffFetch('/data/checklists')
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Checklists</h1>
        <p className="text-[14px] text-steel mt-1">The active checklist template for this workspace.</p>
      </header>
      {checklist == null ? (
        <div className="border border-line bg-white px-4 py-6 text-[14px] text-steel">No active checklist configured.</div>
      ) : (
        <ChecklistBody checklist={checklist} />
      )}
    </div>
  )
}
