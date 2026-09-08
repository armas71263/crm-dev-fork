// Pure bar chart — server-renderable (no client JS), works inside client
// components too. Hairline design system: leaf bars, steel labels.
export default function BarChart({ labels, values, unit = '' }) {
  if (!labels?.length) {
    return <div className="py-6 text-[14px] text-steel">No data yet.</div>
  }
  const nums = values.map((v) => Math.abs(Number(v) || 0))
  const max = Math.max(...nums, 1)
  const fmt = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(Math.round(v * 10) / 10))
  return (
    <div>
      <div className="flex items-end gap-3 h-36">
        {labels.map((l, i) => (
          <div key={`${l}-${i}`} className="flex-1 min-w-0 flex flex-col justify-end items-center h-full gap-1">
            <div className="text-[11px] text-steel">{fmt(values[i])}{unit}</div>
            <div className="w-full bg-leaf/80" style={{ height: `${Math.max((nums[i] / max) * 100, 2)}%` }} />
          </div>
        ))}
      </div>
      <div className="flex gap-3 mt-1">
        {labels.map((l, i) => (
          <div key={`${l}-label-${i}`} className="flex-1 min-w-0 text-center text-[11px] text-steel truncate" title={String(l)}>
            {l}
          </div>
        ))}
      </div>
    </div>
  )
}
