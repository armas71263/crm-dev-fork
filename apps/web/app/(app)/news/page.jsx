import { bffFetch } from '../../../src/lib/bff.js'

const date = (d) => (d ? String(d).slice(0, 10) : '—')
const PRIORITY = { high: 'red', medium: 'amber', low: 'gray' }

export default async function NewsPage() {
  const { feed } = await bffFetch('/data/feed')
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">News feed</h1>
        <p className="text-[14px] text-steel mt-1">Market updates and internal announcements.</p>
      </header>
      {feed.length === 0 && (
        <div className="border border-line bg-white px-4 py-6 text-[14px] text-steel">Nothing published yet.</div>
      )}
      <div className="space-y-3">
        {feed.map((f, i) => (
          <article key={i} className="border border-line bg-white px-4 py-3">
            <div className="flex items-center gap-2 text-[12px] text-steel">
              <span className="uppercase tracking-wide">{f.category}</span>
              {f.priority && <span className={`text-${PRIORITY[f.priority] || 'steel'}`}>· {f.priority} priority</span>}
              <span>· {date(f.published_at)}</span>
            </div>
            <div className="text-[15px] font-medium mt-1">{f.title}</div>
            {f.description && <div className="text-[13px] text-steel mt-1">{f.description}</div>}
          </article>
        ))}
      </div>
    </div>
  )
}
