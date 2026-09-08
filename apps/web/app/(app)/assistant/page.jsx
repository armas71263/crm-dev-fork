'use client'

import { useRef, useState } from 'react'
import BarChart from '../../../components/BarChart.jsx'

// Streaming AI chat. The browser POSTs to the same-origin Next route handler
// (/api/ai/chat/stream), which attaches the verified session JWT and pipes the
// BFF's SSE event stream straight through. Frames: start, tool, observation,
// token, chart, done.
const HINTS = ['Pipeline overview', 'Open tasks', 'Deals by company', 'Chart of pipeline by stage']

export default function AssistantPage() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const sessionId = useRef(Math.random().toString(36).slice(2))

  function patchLast(fn) {
    setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)))
  }

  async function send(text) {
    const message = text.trim()
    if (!message || busy) return
    setInput('')
    setBusy(true)
    setMessages((ms) => [...ms, { role: 'user', text: message }, { role: 'assistant', text: '', tools: [], chart: null, usage: null, provider: null, pending: true }])
    try {
      const res = await fetch('/api/ai/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, session_id: sessionId.current }),
      })
      if (!res.ok || !res.body) throw new Error(`assistant unavailable (HTTP ${res.status})`)
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
          if (event === 'start') patchLast((m) => ({ ...m, provider: data.provider }))
          else if (event === 'tool') patchLast((m) => ({ ...m, tools: [...m.tools, data.name] }))
          else if (event === 'token') patchLast((m) => ({ ...m, text: m.text + data.text }))
          else if (event === 'chart') patchLast((m) => ({ ...m, chart: data }))
          else if (event === 'done') patchLast((m) => ({ ...m, usage: data.usage, tools: data.tools || m.tools, pending: false }))
        }
      }
      patchLast((m) => ({ ...m, pending: false }))
    } catch (err) {
      patchLast((m) => ({ ...m, text: m.text || `The assistant is unavailable right now: ${err.message}`, pending: false }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-4rem)]">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Assistant</h1>
        <p className="text-[14px] text-steel mt-1">Talks to your CRM data — grounded answers, charts on request.</p>
      </header>

      <div className="flex-1 overflow-y-auto space-y-4 pr-1">
        {messages.length === 0 && (
          <div className="border border-line bg-white p-5">
            <div className="text-[14px] font-medium mb-3">Try asking</div>
            <div className="flex flex-wrap gap-2">
              {HINTS.map((h) => (
                <button key={h} onClick={() => send(h)} disabled={busy}
                  className="border border-line px-3 py-1.5 text-[13px] text-ink hover:border-leaf hover:text-leaf">
                  {h}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          m.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] bg-paper border border-line px-4 py-2.5 text-[14px]">{m.text}</div>
            </div>
          ) : (
            <div key={i} className="max-w-[85%] border border-line bg-white px-4 py-3">
              {m.provider && <div className="text-[11px] uppercase tracking-wide text-steel mb-1">{m.provider}</div>}
              {m.tools.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {m.tools.map((t, j) => (
                    <span key={j} className="text-[11px] text-steel border border-line px-1.5 py-0.5">{t}</span>
                  ))}
                </div>
              )}
              <div className="text-[14px] whitespace-pre-wrap">{m.text}{m.pending && <span className="text-steel">▍</span>}</div>
              {m.chart?.labels?.length > 0 && (
                <div className="mt-3 border-t border-line pt-3">
                  <div className="text-[13px] font-medium mb-2">{m.chart.title}</div>
                  <BarChart labels={m.chart.labels} values={m.chart.values} />
                </div>
              )}
              {m.usage && (
                <div className="text-[11px] text-steel mt-2">
                  {m.usage.provider} · {m.usage.latency_ms} ms · {m.usage.tokens_in + m.usage.tokens_out} tokens
                </div>
              )}
            </div>
          )
        ))}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(input) }} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? 'Working…' : 'Ask about your data…'}
          disabled={busy}
          className="flex-1 border border-line bg-white px-3 py-2 text-[14px] outline-none focus:border-leaf disabled:opacity-60"
        />
        <button type="submit" disabled={busy || !input.trim()}
          className="px-4 py-2 bg-leaf text-white text-[14px] font-medium hover:bg-leaf-deep disabled:opacity-50">
          Send
        </button>
      </form>
    </div>
  )
}
