'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '../src/lib/supabase/browser.js'

export default function NavRail({ sections, userEmail }) {
  const pathname = usePathname()
  const router = useRouter()

  async function signOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <nav className="w-56 shrink-0 border-r border-line bg-white h-screen sticky top-0 flex flex-col">
      <div className="px-5 pt-6 pb-5">
        <div className="w-7 h-7 bg-leaf mb-4" />
        <div className="text-[15px] font-semibold tracking-tight">RubberTrack</div>
      </div>
      <div className="flex-1 px-3 space-y-0.5">
        {sections.map((s) => {
          const active = pathname === s.href
          return (
            <Link
              key={s.href}
              href={s.href}
              className={`block px-3 py-2 text-[14px] rounded-none border-l-2 transition-colors ${
                active
                  ? 'border-l-leaf bg-paper font-semibold text-ink'
                  : 'border-l-transparent text-steel hover:text-ink hover:bg-paper'
              }`}
            >
              {s.label}
            </Link>
          )
        })}
      </div>
      <div className="border-t border-line px-5 py-4">
        <div className="text-[13px] text-steel truncate">{userEmail}</div>
        <button
          onClick={signOut}
          className="text-[13px] text-leaf font-medium mt-2 hover:text-leaf-deep"
        >
          Sign out
        </button>
      </div>
    </nav>
  )
}
