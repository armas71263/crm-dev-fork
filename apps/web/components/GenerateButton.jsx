'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Triggers a fresh insights snapshot via the same-origin proxy, then refreshes
// the server-rendered page.
export default function GenerateButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function generate() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/ai/insights', { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      router.refresh()
    } catch (e) {
      setErr(e.message)
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
        {busy ? 'Generating…' : 'Generate now'}
      </button>
      {err && <div className="text-[12px] text-red-600 mt-1">Failed: {err}</div>}
    </div>
  )
}
