import { bffProxy } from '../../../src/lib/bff-proxy.js'

export const dynamic = 'force-dynamic'

export async function POST(request) {
  return bffProxy(request, '/data/chart', { method: 'POST' })
}
