import { bffFetch } from '../../../src/lib/bff.js'

// Global search across the CRM (companies/contacts/leads/deals/activities)
// and the tenant's vertical collections. Server-rendered form (GET), no client JS.
function Section({ title, rows, render }) {
  if (!rows?.length) return null
  return (
    <section>
      <h2 className="text-[15px] font-semibold mb-3">{title} <span className="text-steel font-normal">({rows.length})</span></h2>
      <div className="border border-line bg-white divide-y divide-line">
        {rows.map((r, i) => (
          <div key={i} className="px-4 py-3">
            {render(r)}
          </div>
        ))}
      </div>
    </section>
  )
}

export default async function SearchPage({ searchParams }) {
  const q = String(searchParams?.q || '').trim()
  const results = q ? await bffFetch(`/search?q=${encodeURIComponent(q)}`) : null
  const crm = results?.crm || {}
  const total = results
    ? (crm.companies?.length || 0) + (crm.contacts?.length || 0) + (crm.leads?.length || 0) + (crm.deals?.length || 0) + (crm.activities?.length || 0)
      + (results.records?.length || 0) + (results.parties?.length || 0) + (results.tickets?.length || 0) + (results.feed?.length || 0)
    : 0

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Search</h1>
        <p className="text-[14px] text-steel mt-1">Everything in your workspace, one query.</p>
        <form action="/search" method="get" className="mt-4 flex gap-2 max-w-xl">
          <input
            name="q"
            defaultValue={q}
            placeholder="Search companies, contacts, deals, tasks…"
            className="flex-1 border border-line bg-white px-3 py-2 text-[14px] outline-none focus:border-leaf"
          />
          <button type="submit" className="px-4 py-2 bg-leaf text-white text-[14px] font-medium hover:bg-leaf-deep">
            Search
          </button>
        </form>
      </header>

      {results && (
        <p className="text-[14px] text-steel">
          {total > 0 ? `${total} result${total === 1 ? '' : 's'} for “${q}”.` : `No results for “${q}”.`}
        </p>
      )}

      {results && (
        <>
          <Section title="Companies" rows={crm.companies} render={(r) => (
            <div>
              <div className="text-[14px] font-medium">{r.name}</div>
              <div className="text-[13px] text-steel">{r.type}</div>
            </div>
          )} />
          <Section title="Contacts" rows={crm.contacts} render={(r) => (
            <div>
              <div className="text-[14px] font-medium">{r.full_name}</div>
              <div className="text-[13px] text-steel">{r.title || '—'}</div>
            </div>
          )} />
          <Section title="Leads" rows={crm.leads} render={(r) => (
            <div>
              <div className="text-[14px] font-medium">{r.name}</div>
              <div className="text-[13px] text-steel">{r.company_name || '—'} · {r.status}</div>
            </div>
          )} />
          <Section title="Deals" rows={crm.deals} render={(r) => (
            <div>
              <div className="text-[14px] font-medium">{r.name}</div>
              <div className="text-[13px] text-steel">{r.stage} · {r.status}</div>
            </div>
          )} />
          <Section title="Activities" rows={crm.activities} render={(r) => (
            <div>
              <div className="text-[14px] font-medium">{r.subject}</div>
              <div className="text-[13px] text-steel">{r.type}</div>
            </div>
          )} />
          <Section title="Order records" rows={results.records} render={(r) => (
            <div>
              <div className="text-[14px] font-medium">{r.order_id}</div>
              <div className="text-[13px] text-steel">{r.customer} · {r.grade} · {r.status}</div>
            </div>
          )} />
          <Section title="Suppliers & customers" rows={results.parties} render={(r) => (
            <div>
              <div className="text-[14px] font-medium">{r.name}</div>
              <div className="text-[13px] text-steel">{r.type}</div>
            </div>
          )} />
          <Section title="Issues" rows={results.tickets} render={(r) => (
            <div>
              <div className="text-[14px] font-medium">{r.ticket_id} · {r.category}</div>
              <div className="text-[13px] text-steel truncate">{r.snippet}</div>
            </div>
          )} />
          <Section title="News" rows={results.feed} render={(r) => (
            <div>
              <div className="text-[14px] font-medium">{r.title}</div>
              <div className="text-[13px] text-steel">{r.category}</div>
            </div>
          )} />
        </>
      )}
    </div>
  )
}
