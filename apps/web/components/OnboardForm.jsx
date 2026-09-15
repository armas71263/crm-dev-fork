'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Onboards a tenant: registry row + template clone (records/parties/tickets/
// feed/checklists/screen_configs), exactly like the BFF's vendor endpoint.
export default function OnboardForm() {
  const router = useRouter()
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [template, setTemplate] = useState('rubbertrack')
  const [tier, setTier] = useState('A')
  const [clone, setClone] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  async function onboard(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/tenants', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, label, template, tier, cloneTemplate: clone }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setResult(body)
      setId('')
      setLabel('')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onboard} className="border border-line bg-white p-5 space-y-4">
      <h2 className="text-[15px] font-semibold">Onboard a tenant</h2>
      <div className="grid md:grid-cols-4 gap-3">
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="id (e.g. acme)" required
          className="border border-line px-3 py-2 text-[14px] outline-none focus:border-leaf" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" required
          className="border border-line px-3 py-2 text-[14px] outline-none focus:border-leaf" />
        <select value={template} onChange={(e) => setTemplate(e.target.value)}
          className="border border-line px-3 py-2 text-[14px] outline-none focus:border-leaf bg-white">
          <option value="rubbertrack">rubbertrack template</option>
          <option value="services">services template</option>
        </select>
        <select value={tier} onChange={(e) => setTier(e.target.value)}
          className="border border-line px-3 py-2 text-[14px] outline-none focus:border-leaf bg-white">
          <option value="A">Tier A — pooled RLS</option>
          <option value="B">Tier B — schema-per-tenant</option>
          <option value="C">Tier C — db-per-tenant</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-[13px] text-steel">
        <input type="checkbox" checked={clone} onChange={(e) => setClone(e.target.checked)} />
        Clone template data (records, parties, tickets, feed, screen configs)
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy || !id || !label}
          className="px-4 py-2 bg-leaf text-white text-[14px] font-medium hover:bg-leaf-deep disabled:opacity-50">
          {busy ? 'Onboarding…' : 'Onboard tenant'}
        </button>
        {error && <span className="text-[13px] text-red-600">{error}</span>}
        {result && (
          <span className="text-[13px] text-leaf">
            Onboarded {result.id}
            {result.cloned ? ` · cloned: ${Object.entries(result.cloned).map(([t, n]) => `${t}×${n}`).join(', ')}` : ''}
          </span>
        )}
      </div>
    </form>
  )
}
