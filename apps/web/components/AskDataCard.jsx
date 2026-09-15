'use client'

import { useState } from 'react'

// Phase 6 fallback (plan-sanctioned): the assistant's text-to-SQL exposed as
// a lightweight dashboard feature. Uses the streaming SSE proxy — long-held
// non-streaming requests are fragile in dev; streamed tokens keep the
// connection continuously fed. Read-only SQL enforced by the run_sql tool.
export default function AskDataCard() {
  const [question, setQuestion] = useState('')
  const [reply, setReply] = useState(null)
  const [tools, setTools] = useState([])
  const [busy, setBusy] = useState(false)

  async function ask(e) {
    e.preventDefault()
    const message = question.trim()
    if (!message || busy) return
    setBusy(true)
    setReply('')
    setTools([])
    try {
      const res = await fetch('/api/ai/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, session_id: 'ask-data' }),
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          let event = 'message'
          let data = {}
          for (const line of frame.split('\n')) {
            const p = line.indexOf(': ')
            if (p === -1) continue
            const k = line.slice(0, p)
            const v = line.slice(p + 2)
            if (k === 'event') event = v
            else if (k === 'data') {
              try { Object.assign(data, JSON.parse(v)) } catch { /* keep partial */ }
            }
          }
          if (event === 'tool') setTools((t) => [...t, data.name])
          else if (event === 'token') setReply((r) => (r || '') + data.text)
        }
      }
    } catch (err) {
      setReply((r) => r || `The assistant is unavailable: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-line bg-white p-5">
      <h2 className="text-[15px] font-semibold">Ask the data</h2>
      <p className="text-[13px] text-steel mt-1">Natural-language questions over your workspace — answered live by the AI (read-only SQL).</p>
      <form onSubmit={ask} className="flex gap-2 mt-3">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. How many open deals are there?"
          className="flex-1 border border-line px-3 py-2 text-[14px] outline-none focus:border-leaf"
        />
        <button type="submit" disabled={busy || !question.trim()}
          className="px-4 py-2 bg-leaf text-white text-[14px] font-medium hover:bg-leaf-deep disabled:opacity-50">
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>
      {(reply || tools.length > 0) && (
        <div className="mt-3 border-t border-line pt-3">
          {tools.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {tools.map((t, i) => (
                <span key={i} className="text-[11px] text-steel border border-line px-1.5 py-0.5">{t}</span>
              ))}
            </div>
          )}
          {reply && <div className="text-[14px] whitespace-pre-wrap">{reply}{busy && <span className="text-steel">▍</span>}</div>}
        </div>
      )}
    </div>
  )
}
