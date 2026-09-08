'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../../src/lib/supabase/browser.js'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const supabase = createClient()
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
    if (authError) {
      setError(authError.message === 'Invalid login credentials'
        ? 'Email or password is incorrect.'
        : authError.message)
      setBusy(false)
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  return (
    <main className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="w-10 h-10 bg-leaf mb-5" />
          <h1 className="text-[22px] font-semibold tracking-tight">Sign in</h1>
          <p className="text-[14px] text-steel mt-1">
            Your workspace verifies who you are and which data you can see.
          </p>
        </div>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label htmlFor="email" className="block text-[13px] font-medium text-steel mb-1">Email</label>
            <input
              id="email" type="email" required autoComplete="email"
              value={email} onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-[13px] font-medium text-steel mb-1">Password</label>
            <input
              id="password" type="password" required autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="text-[13px] text-red-700 pt-1">{error}</p>}
          <button
            type="submit" disabled={busy}
            className="w-full bg-leaf text-white text-[14px] font-medium py-2.5 mt-2
              hover:bg-leaf-deep transition-colors disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  )
}
