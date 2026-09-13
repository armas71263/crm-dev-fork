import { bffProxy } from '../../../src/lib/bff-proxy.js'

export const dynamic = 'force-dynamic'

export async function GET(request) {
  return bffProxy(request, '/data/metrics', { method: 'GET' })
}
