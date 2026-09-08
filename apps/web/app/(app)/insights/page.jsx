import { bffFetch } from '../../../src/lib/bff.js'
import GenerateButton from '../../../components/GenerateButton.jsx'

// Auto-computed insight snapshots (AI service cron + on-demand regeneration).
export default async function InsightsPage() {
  const snap = await bffFetch('/ai/insights/latest')
  const generated = snap.generated_at
    ? new Date(snap.generated_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : null

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Insights</h1>
          <p className="text-[14px] text-steel mt-1">
            {generated ? `Latest snapshot · ${generated}${snap.provider ? ` · ${snap.provider}` : ''}` : 'No snapshot yet.'}
          </p>
        </div>
        <GenerateButton />
      </header>

      {snap.insights?.length ? (
        <div className="border border-line bg-white divide-y divide-line">
          {snap.insights.map((line, i) => (
            <div key={i} className="px-4 py-3 text-[14px] flex gap-3">
              <span className="text-leaf font-semibold">{i + 1}</span>
              <span>{line}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="border border-line bg-white px-4 py-6 text-[14px] text-steel">
          Nothing generated yet — press “Generate now” to compute the first snapshot.
        </div>
      )}
    </div>
  )
}
