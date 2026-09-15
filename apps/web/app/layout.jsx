import './globals.css'
import { IBM_Plex_Sans } from 'next/font/google'

const plex = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex',
  display: 'swap',
})

export const metadata = {
  title: 'RubberTrack',
  description: 'Multi-tenant CRM, analytics and AI platform',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={plex.variable}>
      <body>{children}</body>
    </html>
  )
}
