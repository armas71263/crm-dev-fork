import { bffFetch } from '../../../src/lib/bff.js'
import StatusDot from '../../../components/StatusDot.jsx'
import BarChart from '../../../components/BarChart.jsx'
import GenerateForecastButton from '../../../components/GenerateForecastButton.jsx'
import AskDataCard from '../../../components/AskDataCard.jsx'

const usd = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US')
const date = (d) => (d ? String(d).slice(0, 10) : '—')

const STAGE_TONES = { won: 'green', lost: 'red' }

export default async function DashboardPage() {
  const [data, pipeline, stored] = await Promise.all([
    bffFetch('/data/crm/dashboard'),
    bffFetch('/data/kpi/chart?table=deals&dimension=stage&metric=value'),
    bffFetch('/data/forecast/record_mt').catch(() => ({ forecast: null })),
  ])
  const k = data.kpi
  const kpis = [
    ['Companies', k.companies],
    ['Contacts', k.contacts],
    ['Open leads', k.open_leads],
    ['Open deals', k.open_deals],
    ['Pipeline value', usd(k.pipeline_value)],
    ['Open tasks', `${k.open_tasks}${k.overdue_tasks ? ` (${k.overdue_tasks} overdue)` : ''}`],
  ]

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Dashboard</h1>
        <p className="text-[14px] text-steel mt-1">Live view of your workspace.</p>
      </header>

      <div className="kpi-strip grid grid-cols-2 md:grid-cols-6">
        {kpis.map(([label, value]) => (
          <div key={label} className="kpi-cell">
            <div className="text-[13px] text-steel">{label}</div>
            <div className="text-[26px] font-semibold tracking-tight mt-1">{value}</div>
          </div>
        ))}
      </div>

      <section className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <div className="border border-line bg-white p-5">
            <h2 className="text-[15px] font-semibold mb-4">Open pipeline by stage</h2>
            <BarChart labels={pipeline.labels} values={pipeline.values} unit="$" />
          </div>
          <div className="border border-line bg-white p-5">
            <div className="flex items-center justify-between mb-4 gap-4">
              <div>
                <h2 className="text-[15px] font-semibold">Volume forecast</h2>
                <p className="text-[13px] text-steel">
                  {stored.forecast ? `Monthly order volume (MT) · ${stored.forecast.model} · generated ${new Date(stored.forecast.generated_at).toLocaleDateString('en-US', { dateStyle: 'medium' })}` : 'Six-month projection of order volume'}
                </p>
              </div>
              <GenerateForecastButton />
            </div>
            {stored.forecast?.forecast?.length
              ? <BarChart labels={stored.forecast.forecast.map((r) => r.m)} values={stored.forecast.forecast.map((r) => r.v)} unit=" MT" />
              : <p className="text-[14px] text-steel py-4">No stored forecast yet — press Generate forecast (needs 8+ months of history).</p>}
          </div>
          <div>
            <h2 className="text-[15px] font-semibold mb-3">Recent deals</h2>
            <div className="border border-line bg-white overflow-x-auto">
              <table className="w-full datatable border-collapse">
                <thead>
                  <tr>
                    <th>Deal</th><th>Company</th><th>Stage</th>
                    <th className="text-right">Value</th><th>Expected close</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent_deals.map((d) => (
                    <tr key={d.id}>
                      <td>{d.name}</td>
                      <td>{d.company || '—'}</td>
                      <td>{d.stage}</td>
                      <td className="text-right">{d.value != null ? usd(d.value) : '—'} {d.currency || ''}</td>
                      <td>{date(d.expected_close_date)}</td>
                      <td><StatusDot status={d.status} tone={STAGE_TONES[d.stage] || 'gray'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="space-y-8">
          <div>
            <h2 className="text-[15px] font-semibold mb-3">Upcoming tasks</h2>
            <div className="border border-line bg-white divide-y divide-line">
              {data.upcoming_tasks.length === 0 && (
                <div className="px-4 py-3 text-[14px] text-steel">No open tasks.</div>
              )}
              {data.upcoming_tasks.map((t) => (
                <div key={t.id} className="px-4 py-3">
                  <div className="text-[14px] font-medium">{t.subject}</div>
                  <div className="text-[13px] text-steel">{t.entity} · due {date(t.due_at)}</div>
                </div>
              ))}
            </div>
          </div>
          <AskDataCard />
          <div className="border border-line bg-white p-5">
            <h2 className="text-[15px] font-semibold mb-2">Full assistant</h2>
            <p className="text-[13px] text-steel">
              Streaming chat with charts and memory.{' '}
              <a href="/assistant" className="text-leaf font-medium hover:text-leaf-deep">Open assistant →</a>
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
