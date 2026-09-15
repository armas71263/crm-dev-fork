import { bffProxy } from '../../../src/lib/bff-proxy.js'

export const dynamic = 'force-dynamic'

export async function GET(request) {
  return bffProxy(request, '/data/dashboard-widgets', { method: 'GET' })
}

export async function POST(request) {
  return bffProxy(request, '/data/dashboard-widgets', { method: 'POST' })
}
