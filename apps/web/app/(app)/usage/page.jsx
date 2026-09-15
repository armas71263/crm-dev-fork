import { bffFetch } from '../../../src/lib/bff.js'

// AI usage accounting: every chat/insights call is logged per tenant with
// provider, tokens and latency (ai_usage_logs, RLS-scoped).
export default async function UsagePage() {
  const { recent, by_provider: byProvider } = await bffFetch('/ai/usage?limit=50')
  const totalCalls = byProvider.reduce((s, p) => s + p.calls, 0)
  const totalTokens = byProvider.reduce((s, p) => s + p.tokens, 0)
  const time = (t) => (t ? new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—')

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">AI usage</h1>
        <p className="text-[14px] text-steel mt-1">{totalCalls} AI calls · {totalTokens.toLocaleString('en-US')} tokens accounted.</p>
      </header>

      <div className="kpi-strip grid grid-cols-2 md:grid-cols-4">
        {byProvider.length === 0 && (
          <div className="kpi-cell">
            <div className="text-[13px] text-steel">No AI calls yet</div>
            <div className="text-[26px] font-semibold tracking-tight mt-1">0</div>
          </div>
        )}
        {byProvider.map((p) => (
          <div key={p.provider} className="kpi-cell">
            <div className="text-[13px] text-steel">{p.provider}</div>
            <div className="text-[26px] font-semibold tracking-tight mt-1">{p.calls}</div>
            <div className="text-[12px] text-steel mt-1">{p.tokens.toLocaleString('en-US')} tokens · ${(p.cost || 0).toFixed(4)}</div>
          </div>
        ))}
      </div>

      <section>
        <h2 className="text-[15px] font-semibold mb-3">Recent calls</h2>
        <div className="border border-line bg-white overflow-x-auto">
          <table className="w-full datatable border-collapse">
            <thead>
              <tr>
                <th>Provider</th><th>Tool</th>
                <th className="text-right">Tokens in</th><th className="text-right">Tokens out</th>
                <th className="text-right">Latency</th><th>When</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 && (
                <tr><td colSpan={6} className="text-[14px] text-steel py-4">No AI calls logged yet.</td></tr>
              )}
              {recent.map((r, i) => (
                <tr key={i}>
                  <td>{r.provider}</td>
                  <td>{r.tool}</td>
                  <td className="text-right">{r.tokens_in}</td>
                  <td className="text-right">{r.tokens_out}</td>
                  <td className="text-right">{Math.round(r.latency_ms)} ms</td>
                  <td>{time(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
