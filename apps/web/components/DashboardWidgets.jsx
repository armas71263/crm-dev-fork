'use client'

import { useEffect, useState } from 'react'
import BarChart from './BarChart.jsx'

// Phase 6.7 self-serve dashboard: widgets store the QUERY (certified metric
// or dimension aggregation) — data is re-run live on every visit, so pinned
// charts never go stale.
export default function DashboardWidgets() {
  const [widgets, setWidgets] = useState(null)
  const [data, setData] = useState({})
  const [metrics, setMetrics] = useState([])
  const [busy, setBusy] = useState(false)

  async function load() {
    setBusy(true)
    try {
      const [wRes, mRes] = await Promise.all([
        fetch('/api/dashboard-widgets'),
        fetch('/api/metrics'),
      ])
      const wb = await wRes.json()
      const mb = await mRes.json()
      const ws = wb.widgets || []
      setWidgets(ws)
      setMetrics(mb.metrics || [])
      const next = {}
      await Promise.all(ws.map(async (w) => {
        try {
          if (w.spec?.source === 'metric') {
            const r = await fetch(`/api/metrics/${w.spec.metricKey}/run`, { method: 'POST' })
            next[w.id] = await r.json()
          } else if (w.spec?.source === 'chart') {
            const r = await fetch('/api/chart', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ scope: w.spec.scope, dimension: w.spec.dimension, metric: w.spec.metric, filter: w.spec.filter }),
            })
            next[w.id] = await r.json()
          }
        } catch {
          next[w.id] = { error: true }
        }
      }))
      setData(next)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { load() }, [])

  async function addMetric(key) {
    if (!key) return
    const m = metrics.find((x) => x.key === key)
    await fetch('/api/dashboard-widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { source: 'metric', metricKey: key, title: m?.label || key } }),
    })
    load()
  }

  async function remove(id) {
    await fetch(`/api/dashboard-widgets/${id}`, { method: 'DELETE' })
    load()
  }

  async function move(id, dir) {
    const ws = [...(widgets || [])]
    const i = ws.findIndex((w) => w.id === id)
    const j = i + dir
    if (i === -1 || j < 0 || j >= ws.length) return
    const a = ws[i].position
    const b = ws[j].position
    await Promise.all([
      fetch(`/api/dashboard-widgets/${ws[i].id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ position: b }) }),
      fetch(`/api/dashboard-widgets/${ws[j].id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ position: a }) }),
    ])
    load()
  }

  return (
    <div className="border border-line bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[15px] font-semibold">My dashboard</h2>
        <div className="flex items-center gap-3">
          <select
            value=""
            onChange={(e) => addMetric(e.target.value)}
            className="border border-line px-2 py-1 text-[13px] bg-white"
          >
            <option value="">+ Add metric card…</option>
            {metrics.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
          <button onClick={load} disabled={busy} className="text-[13px] text-leaf font-medium hover:text-leaf-deep">
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {widgets === null ? (
        <div className="text-[14px] text-steel">Loading…</div>
      ) : widgets.length === 0 ? (
        <div className="text-[14px] text-steel">
          No widgets yet. Pin a chart from a conversation in the Assistant, or add a certified metric card above.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {widgets.map((w) => (
            <div key={w.id} className="border border-line p-4">
              <div className="flex items-start justify-between mb-2">
                <div className="text-[13px] font-medium">{w.spec.title || (w.spec.source === 'metric' ? w.spec.metricKey : w.spec.dimension)}</div>
                <div className="flex items-center gap-1.5 text-[12px] text-steel">
                  <button onClick={() => move(w.id, -1)} className="hover:text-ink">▲</button>
                  <button onClick={() => move(w.id, 1)} className="hover:text-ink">▼</button>
                  <button onClick={() => remove(w.id)} className="hover:text-rust">✕</button>
                </div>
              </div>
              {w.spec.source === 'metric' ? (
                data[w.id]?.value !== undefined ? (
                  <div className="text-[30px] font-semibold tracking-tight">
                    {typeof data[w.id].value === 'number' && (w.spec.title || '').match(/value|revenue/i)
                      ? '$' + Math.round(data[w.id].value).toLocaleString('en-US')
                      : String(data[w.id].value)}
                    {data[w.id].unit ? ` ${data[w.id].unit}` : ''}
                  </div>
                ) : (
                  <div className="text-[13px] text-steel">{data[w.id]?.error ? 'Unavailable' : 'Loading…'}</div>
                )
              ) : data[w.id]?.labels ? (
                <BarChart labels={data[w.id].labels} values={data[w.id].values} />
              ) : (
                <div className="text-[13px] text-steel">{data[w.id]?.error ? 'Unavailable' : 'Loading…'}</div>
              )}
              {w.spec.source === 'chart' && (
                <div className="text-[11px] text-steel mt-2">{w.spec.scope} · {w.spec.metric} by {w.spec.dimension}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
