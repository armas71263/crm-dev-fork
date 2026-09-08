// Server-renderable table: columns = [{ key, label, render? }]
export default function DataTable({ columns, rows, empty = 'Nothing here yet.' }) {
  if (!rows?.length) {
    return <div className="border border-line bg-white px-4 py-6 text-[14px] text-steel">{empty}</div>
  }
  return (
    <div className="border border-line bg-white overflow-x-auto">
      <table className="w-full datatable border-collapse">
        <thead>
          <tr>
            {columns.map((c) => <th key={c.key}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id ?? i}>
              {columns.map((c) => (
                <td key={c.key}>{c.render ? c.render(row) : (row[c.key] ?? '—')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
