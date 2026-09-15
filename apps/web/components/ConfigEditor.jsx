'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// JSON-textarea editor: validates before saving; the BFF deactivates the old
// row and inserts the new one (versioned per screen).
export default function ConfigEditor({ screen, config }) {
  const router = useRouter()
  const [text, setText] = useState(() => JSON.stringify(config ?? {}, null, 2))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      setError(`Invalid JSON: ${e.message}`)
      setBusy(false)
      return
    }
    try {
      const res = await fetch('/api/screen-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ screen, config: parsed }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSaved(true)
      router.refresh()
    } catch (e) {
      setError(`Save failed: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-line bg-white p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">{screen} — layout config</h2>
        <div className="flex items-center gap-3">
          {saved && <span className="text-[13px] text-leaf">Saved</span>}
          <button onClick={save} disabled={busy}
            className="px-4 py-2 bg-leaf text-white text-[14px] font-medium hover:bg-leaf-deep disabled:opacity-50">
            {busy ? 'Saving…' : 'Save config'}
          </button>
        </div>
      </div>
      {config === null && (
        <p className="text-[13px] text-steel">No saved config yet — this editor starts from an empty layout.</p>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={16}
        className="w-full border border-line p-3 font-mono text-[12.5px] leading-relaxed outline-none focus:border-leaf"
      />
      {error && <div className="text-[13px] text-red-600">{error}</div>}
    </div>
  )
}
