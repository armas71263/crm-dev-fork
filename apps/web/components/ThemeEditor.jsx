'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Same field set as the legacy preview theme.json (logoText, primary, accent,
// bg, panel, text) so existing tenant themes keep working.
const FIELDS = [
  ['logoText', 'Logo text', 'text'],
  ['primary', 'Primary', 'color'],
  ['accent', 'Accent', 'color'],
  ['bg', 'Background', 'color'],
  ['panel', 'Panel', 'color'],
  ['text', 'Text', 'color'],
]

export default function ThemeEditor({ initial }) {
  const router = useRouter()
  const [theme, setTheme] = useState(() => ({
    logoText: initial.logoText || '',
    primary: initial.primary || '#2E5E4E',
    accent: initial.accent || '#2E5E4E',
    bg: initial.bg || '#F7F6F2',
    panel: initial.panel || '#FFFFFF',
    text: initial.text || '#1A1D1A',
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const res = await fetch('/api/theme', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ theme }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSaved(true)
      router.refresh()
    } catch (err) {
      setError(`Save failed: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="border border-line bg-white p-5 space-y-5 max-w-xl">
      <div className="grid md:grid-cols-2 gap-4">
        {FIELDS.map(([key, label, type]) => (
          <label key={key} className="block">
            <span className="text-[13px] text-steel">{label}</span>
            {type === 'color' ? (
              <span className="flex items-center gap-2 mt-1">
                <input
                  type="color"
                  value={theme[key]}
                  onChange={(e) => setTheme((t) => ({ ...t, [key]: e.target.value }))}
                  className="w-9 h-9 border border-line bg-white p-0.5"
                />
                <input
                  value={theme[key]}
                  onChange={(e) => setTheme((t) => ({ ...t, [key]: e.target.value }))}
                  className="flex-1 border border-line px-2 py-1.5 text-[13px] font-mono outline-none focus:border-leaf"
                />
              </span>
            ) : (
              <input
                value={theme[key]}
                onChange={(e) => setTheme((t) => ({ ...t, [key]: e.target.value }))}
                className="w-full mt-1 border border-line px-3 py-2 text-[14px] outline-none focus:border-leaf"
              />
            )}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy}
          className="px-4 py-2 bg-leaf text-white text-[14px] font-medium hover:bg-leaf-deep disabled:opacity-50">
          {busy ? 'Saving…' : 'Save theme'}
        </button>
        <button type="button" onClick={() => setTheme({ logoText: '', primary: '#2E5E4E', accent: '#2E5E4E', bg: '#F7F6F2', panel: '#FFFFFF', text: '#1A1D1A' })}
          className="text-[13px] text-steel hover:text-ink">
          Reset to defaults
        </button>
        {saved && <span className="text-[13px] text-leaf">Saved — visible in the rail after refresh.</span>}
        {error && <span className="text-[13px] text-red-600">{error}</span>}
      </div>
    </form>
  )
}
