'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

// URL-as-state (Phase 6.5): filters live in the query string, so any filtered
// view is a shareable link and survives reload/back. The page re-renders from
// searchParams server-side.
export default function UrlFilterBar({ fields, statuses = [] }) {
  const router = useRouter()
  const params = useSearchParams()
  const [q, setQ] = useState(params.get('q') || '')
  const [status, setStatus] = useState(params.get('status') || '')

  function push(nextQ = q, nextStatus = status) {
    const sp = new URLSearchParams()
    if (nextQ) sp.set('q', nextQ)
    if (nextStatus) sp.set('status', nextStatus)
    router.push(`?${sp.toString()}`, { scroll: false })
  }

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <form
        onSubmit={(e) => { e.preventDefault(); push() }}
        className="flex-1 min-w-[220px] flex gap-2"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${fields.join(', ')}…`}
          className="flex-1 border border-line px-3 py-2 text-[14px] outline-none focus:border-leaf bg-white"
        />
        <button type="submit" className="px-4 py-2 bg-ink text-white text-[14px] font-medium hover:bg-ink/90">
          Search
        </button>
      </form>
      {statuses.length > 0 && (
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); push(q, e.target.value) }}
          className="border border-line px-3 py-2 text-[14px] bg-white"
        >
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      )}
      {(q || status) && (
        <button
          onClick={() => { setQ(''); setStatus(''); push('', '') }}
          className="text-[13px] text-steel hover:text-ink"
        >
          Clear
        </button>
      )}
    </div>
  )
}
