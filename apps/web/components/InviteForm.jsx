'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Invites create the Supabase auth user (app_metadata carries tenant/role,
// service-role-writable only) + a profiles row. Without email infrastructure
// the invite link is surfaced here for manual delivery.
export default function InviteForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('staff')
  const [companyId, setCompanyId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  async function invite(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/users/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          role,
          companyId: role === 'customer' ? companyId : null,
          displayName: displayName || null,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setResult(body)
      setEmail('')
      setDisplayName('')
      setCompanyId('')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={invite} className="border border-line bg-white p-5 space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold">Invite a user</h2>
        <p className="text-[13px] text-steel mt-1">They set their own password via the invite link.</p>
      </div>
      <div className="grid md:grid-cols-2 gap-3 max-w-2xl">
        <input
          value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@company.com" required type="email"
          className="border border-line px-3 py-2 text-[14px] outline-none focus:border-leaf"
        />
        <input
          value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name (optional)"
          className="border border-line px-3 py-2 text-[14px] outline-none focus:border-leaf"
        />
        <select
          value={role} onChange={(e) => setRole(e.target.value)}
          className="border border-line px-3 py-2 text-[14px] outline-none focus:border-leaf bg-white"
        >
          <option value="staff">Staff — full workspace</option>
          <option value="customer">Customer — portal only</option>
        </select>
        {role === 'customer' && (
          <input
            value={companyId} onChange={(e) => setCompanyId(e.target.value)} placeholder="Company scope (e.g. CEAT)" required
            className="border border-line px-3 py-2 text-[14px] outline-none focus:border-leaf"
          />
        )}
      </div>
      <button type="submit" disabled={busy || !email}
        className="px-4 py-2 bg-leaf text-white text-[14px] font-medium hover:bg-leaf-deep disabled:opacity-50">
        {busy ? 'Inviting…' : 'Send invite'}
      </button>
      {error && <div className="text-[13px] text-red-600">{error}</div>}
      {result?.invite_url && (
        <div className="border border-line bg-paper px-3 py-2">
          <div className="text-[12px] text-steel mb-1">Invite link (email delivery not configured):</div>
          <div className="text-[12px] break-all font-mono">{result.invite_url}</div>
        </div>
      )}
    </form>
  )
}
