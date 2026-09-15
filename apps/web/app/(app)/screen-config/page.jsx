import { bffFetch } from '../../../src/lib/bff.js'
import ConfigEditor from '../../../components/ConfigEditor.jsx'

// Per-tenant screen configs (which charts/cards a screen shows). The editor is
// a validated JSON textarea — the dashboard and chart builder consume these.
export default async function ScreenConfigPage({ searchParams }) {
  const screen = String(searchParams?.screen || 'dashboard')
  const { config } = await bffFetch(`/data/screen-config?screen=${encodeURIComponent(screen)}`)
  const screens = ['dashboard', 'records', 'issues', 'news', 'assistant']

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Screen config</h1>
        <p className="text-[14px] text-steel mt-1">Reconfigure screens without code — stored per tenant, versioned.</p>
        <div className="flex flex-wrap gap-2 mt-4">
          {screens.map((s) => (
            <a key={s} href={`/screen-config?screen=${s}`}
              className={`px-3 py-1.5 text-[13px] border ${s === screen ? 'border-leaf text-leaf font-medium' : 'border-line text-steel hover:text-ink'}`}>
              {s}
            </a>
          ))}
        </div>
      </header>

      <ConfigEditor screen={screen} config={config} />
    </div>
  )
}
