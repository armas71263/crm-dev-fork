import { bffFetch } from '../../../src/lib/bff.js'
import SuggestionActions from '../../../components/SuggestionActions.jsx'

const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))

export default async function SuggestionsPage() {
  const [{ suggestions }, { tasks }] = await Promise.all([
    bffFetch('/data/suggestions'),
    bffFetch('/data/agent-tasks'),
  ])
  const pending = suggestions.filter((s) => s.status === 'pending')
  const resolved = suggestions.filter((s) => s.status !== 'pending').slice(0, 10)

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Suggestions</h1>
        <p className="text-[14px] text-steel mt-1">
          The AI never edits your records — it queues changes here with its evidence. You decide.
        </p>
      </header>

      <section className="space-y-3">
        {pending.length === 0 && (
          <div className="border border-line bg-white p-6 text-[14px] text-steel">
            No pending suggestions. Ask the assistant to update a record and it will propose the change here.
          </div>
        )}
        {pending.map((s) => (
          <div key={s.id} className="border border-line bg-white p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[15px] font-medium">
                  {s.entity_type} #{s.entity_id}: change <span className="font-semibold">{s.field}</span>
                </div>
                <div className="text-[14px] mt-1">
                  <span className="text-steel">{fmt(s.current_value)}</span>
                  <span className="mx-2 text-steel">→</span>
                  <span className="font-medium text-ink">{fmt(s.proposed_value)}</span>
                </div>
                {s.evidence && (
                  <div className="text-[13px] text-steel mt-2 border-l-2 border-line pl-3">{s.evidence}</div>
                )}
                <div className="text-[12px] text-steel mt-2">proposed {new Date(s.created_at).toLocaleString()}</div>
              </div>
              <SuggestionActions id={s.id} />
            </div>
          </div>
        ))}
      </section>

      {resolved.length > 0 && (
        <section>
          <h2 className="text-[15px] font-semibold mb-3">Recently settled</h2>
          <div className="border border-line bg-white">
            {resolved.map((s) => (
              <div key={s.id} className="flex items-center justify-between px-5 py-3 border-b border-line last:border-b-0 text-[14px]">
                <span>
                  {s.entity_type} #{s.entity_id} · {s.field} → {fmt(s.proposed_value)}
                </span>
                <span className={s.status === 'accepted' ? 'text-leaf font-medium' : 'text-steel'}>{s.status}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-[15px] font-semibold mb-3">Scheduled agent work</h2>
        {tasks.length === 0 ? (
          <div className="border border-line bg-white p-6 text-[14px] text-steel">
            No scheduled tasks. The assistant can schedule follow-up work (insights/forecast refresh) with schedule_task.
          </div>
        ) : (
          <div className="border border-line bg-white">
            {tasks.map((t) => (
              <div key={t.id} className="flex items-center justify-between px-5 py-3 border-b border-line last:border-b-0 text-[14px]">
                <span className="font-medium">{t.task_type}</span>
                <span className="text-steel text-[13px]">
                  {t.status}{t.due_at ? ` · due ${new Date(t.due_at).toLocaleString()}` : ''}
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
