'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Triggers a forecast job (retrain + store) via the same-origin proxy. Cold
// tenants get an explicit insufficient-data answer, never a fake forecast.
export default function GenerateForecastButton({ series = 'record_mt' }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  async function generate() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/forecast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ series }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`)
      if (!body.ok) setMsg(`No forecast: ${body.error} (${body.points ?? '?'} points, need ${body.minimum})`)
      else {
        setMsg(`Forecast ready (${body.model})`)
        router.refresh()
      }
    } catch (e) {
      setMsg(`Failed: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="text-right">
      <button
        onClick={generate}
        disabled={busy}
        className="px-4 py-2 bg-leaf text-white text-[14px] font-medium hover:bg-leaf-deep disabled:opacity-50"
      >
        {busy ? 'Forecasting…' : 'Generate forecast'}
      </button>
      {msg && <div className="text-[12px] text-steel mt-1">{msg}</div>}
    </div>
  )
}
