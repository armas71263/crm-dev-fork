import { bffFetch } from '../../../src/lib/bff.js'

// Customer portal: company-scoped overview backed by /portal/overview. The
// BFF resolves the company from the verified token — nothing here can see
// another company's rows.
const usd = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US')
const date = (d) => (d ? String(d).slice(0, 10) : '—')

export default async function PortalPage() {
  const data = await bffFetch('/portal/overview')
  const kpis = [
    ['Orders', data.kpi.orders],
    ['Volume', `${data.kpi.mt} MT`],
    ['Value', usd(data.kpi.revenue)],
  ]

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Overview</h1>
        <p className="text-[14px] text-steel mt-1">Your account with us.</p>
      </header>

      <div className="kpi-strip grid grid-cols-2 md:grid-cols-3">
        {kpis.map(([label, value]) => (
          <div key={label} className="kpi-cell">
            <div className="text-[13px] text-steel">{label}</div>
            <div className="text-[26px] font-semibold tracking-tight mt-1">{value}</div>
          </div>
        ))}
      </div>

      <section>
        <h2 className="text-[15px] font-semibold mb-3">Your orders</h2>
        <div className="border border-line bg-white overflow-x-auto">
          <table className="w-full datatable border-collapse">
            <thead>
              <tr><th>Order</th><th>Date</th><th>Grade</th><th className="text-right">MT</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.orders.length === 0 && (
                <tr><td colSpan={5} className="text-[14px] text-steel py-4">No orders yet.</td></tr>
              )}
              {data.orders.map((o) => (
                <tr key={o.order_id}>
                  <td>{o.order_id}</td>
                  <td>{date(o.date)}</td>
                  <td>{o.grade}</td>
                  <td className="text-right">{o.mt}</td>
                  <td>{o.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-[15px] font-semibold mb-3">Open issues</h2>
        <div className="border border-line bg-white divide-y divide-line">
          {data.issues.length === 0 && (
            <div className="px-4 py-3 text-[14px] text-steel">No open issues.</div>
          )}
          {data.issues.map((i) => (
            <div key={i.ticket_id} className="px-4 py-3">
              <div className="text-[14px] font-medium">{i.category}</div>
              <div className="text-[13px] text-steel truncate">{i.description}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
