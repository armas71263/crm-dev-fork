'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Accept applies the whitelisted field through the BFF; reject only marks.
// Either way a human settles it — the AI queued it, people decide.
export default function SuggestionActions({ id }) {
  const router = useRouter()
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  async function resolve(action) {
    if (busy) return
    setBusy(action)
    setError(null)
    try {
      const res = await fetch(`/api/suggestions/${id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      router.refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => resolve('accept')}
        disabled={!!busy}
        className="px-3 py-1.5 text-[13px] font-medium bg-leaf text-white hover:bg-leaf-deep disabled:opacity-50"
      >
        {busy === 'accept' ? 'Applying…' : 'Accept'}
      </button>
      <button
        onClick={() => resolve('reject')}
        disabled={!!busy}
        className="px-3 py-1.5 text-[13px] border border-line hover:bg-paper disabled:opacity-50"
      >
        {busy === 'reject' ? 'Rejecting…' : 'Reject'}
      </button>
      {error && <span className="text-[12px] text-rust">{error}</span>}
    </div>
  )
}
