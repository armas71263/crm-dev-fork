import { bffFetch } from '../../../src/lib/bff.js'
import StatusDot from '../../../components/StatusDot.jsx'

const ORDER_TONES = { Open: 'green', 'In Production': 'amber', Shipped: 'amber', Delivered: 'gray' }

export default async function DashboardPage() {
  const data = await bffFetch('/data/dashboard')
  const kpis = [
    ['Open orders', data.kpi.open_orders],
    ['Active volume', `${data.kpi.active_mt} MT`],
    ['Suppliers', data.kpi.suppliers],
    ['Customers', data.kpi.customers],
    ['Open issues', data.kpi.open_issues],
  ]

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Dashboard</h1>
        <p className="text-[14px] text-steel mt-1">Live view of your workspace.</p>
      </header>

      <div className="kpi-strip grid grid-cols-2 md:grid-cols-5">
        {kpis.map(([label, value]) => (
          <div key={label} className="kpi-cell">
            <div className="text-[13px] text-steel">{label}</div>
            <div className="text-[26px] font-semibold tracking-tight mt-1">{value}</div>
          </div>
        ))}
      </div>

      <section className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          <h2 className="text-[15px] font-semibold mb-3">Recent orders</h2>
          <div className="border border-line bg-white overflow-x-auto">
            <table className="w-full datatable border-collapse">
              <thead>
                <tr>
                  <th>Order</th><th>Customer</th><th>Grade</th>
                  <th className="text-right">MT</th><th className="text-right">USD/t</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.slice(0, 6).map((o) => (
                  <tr key={o.order_id}>
                    <td>{o.order_id}</td>
                    <td>{o.customer}</td>
                    <td>{o.grade}</td>
                    <td className="text-right">{o.mt}</td>
                    <td className="text-right">{o.price_usd}</td>
                    <td><StatusDot status={o.status} tone={ORDER_TONES[o.status] || 'gray'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-8">
          <div>
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
          </div>
          <div>
            <h2 className="text-[15px] font-semibold mb-3">News</h2>
            <div className="border border-line bg-white divide-y divide-line">
              {data.feed.slice(0, 4).map((f, idx) => (
                <div key={idx} className="px-4 py-3">
                  <div className="text-[14px] font-medium">{f.title}</div>
                  <div className="text-[13px] text-steel">{f.category}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
