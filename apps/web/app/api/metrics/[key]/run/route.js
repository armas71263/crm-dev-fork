import { bffProxy } from '../../../../../src/lib/bff-proxy.js'

export const dynamic = 'force-dynamic'

export async function POST(request, { params }) {
  return bffProxy(request, `/data/metrics/${params.key}/run`, { method: 'POST' })
}
