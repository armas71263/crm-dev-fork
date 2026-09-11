import { bffFetch } from '../../../src/lib/bff.js'

// Ops surface (Phase 7): the deep-health matrix (what an uptime monitor polls)
// plus the durable agent task queue. Staff-only via the BFF auth.
export const dynamic = 'force-dynamic'

export default async function OpsPage() {
  let health = null
  let tasks = []
  let err = null
  try {
    health = await bffFetch('/health/deep')
  } catch (e) {
    err = e.message
  }
  try {
    const t = await bffFetch('/data/agent-tasks')
    tasks = t.tasks || []
  } catch { /* task list is non-critical */ }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Ops</h1>
        <p className="text-[14px] text-steel mt-1">Service health (deep checks) and the durable agent task queue.</p>
      </header>

      <section>
        <h2 className="text-[15px] font-semibold mb-3">Service health</h2>
        {err ? (
          <div className="border border-line bg-white p-6 text-[14px] text-rust">Deep health unavailable: {err}</div>
        ) : (
          <div className="border border-line bg-white">
            <div className="px-5 py-3 border-b border-line flex items-center justify-between">
              <span className="text-[14px] font-medium">Overall</span>
              <span className={health.status === 'ok' ? 'text-leaf font-medium text-[14px]' : 'text-rust font-medium text-[14px]'}>
                {health.status}
              </span>
            </div>
            {Object.entries(health.checks).map(([name, c]) => (
              <div key={name} className="px-5 py-3 border-b border-line last:border-b-0 flex items-center justify-between text-[14px]">
                <span className="font-medium">{name}</span>
                <span className="text-steel text-[13px]">
                  <span className={c.status === 'up' ? 'text-leaf' : 'text-rust'}>{c.status}</span> · {c.latency_ms}ms
                  {c.error ? ` · ${c.error}` : ''}
                </span>
              </div>
            ))}
            <div className="px-5 py-3 text-[12px] text-steel">BFF uptime {health.uptime_seconds}s · raw JSON at /health/deep · Prometheus at /metrics</div>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-[15px] font-semibold mb-3">Agent tasks</h2>
        {tasks.length === 0 ? (
          <div className="border border-line bg-white p-6 text-[14px] text-steel">No tasks yet.</div>
        ) : (
          <div className="border border-line bg-white">
            {tasks.map((t) => (
              <div key={t.id} className="px-5 py-3 border-b border-line last:border-b-0 flex items-center justify-between text-[14px]">
                <span className="font-medium">{t.task_type}</span>
                <span className="text-steel text-[13px]">
                  <span className={t.status === 'done' ? 'text-leaf' : t.status === 'failed' ? 'text-rust' : 'text-ink'}>{t.status}</span>
                  {t.due_at ? ` · due ${new Date(t.due_at).toLocaleString()}` : ''}
                  {t.attempts > 1 ? ` · ${t.attempts} attempts` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
