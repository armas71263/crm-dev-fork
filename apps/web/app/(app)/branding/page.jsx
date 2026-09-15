import { bffFetch } from '../../../src/lib/bff.js'
import ThemeEditor from '../../../components/ThemeEditor.jsx'

// White-label branding: the theme JSON lives in app.tenants.theme, scoped to
// the caller's own tenant by the BFF. Logo text + accent land in the nav rail.
export default async function BrandingPage() {
  const { label, theme } = await bffFetch('/data/theme')
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-[24px] font-semibold tracking-tight">Branding</h1>
        <p className="text-[14px] text-steel mt-1">
          {label ? `Workspace: ${label}` : 'Your workspace'} — logo text and palette for the app chrome.
        </p>
      </header>
      <ThemeEditor initial={theme || {}} />
    </div>
  )
}
