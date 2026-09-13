import { bffProxy } from '../../../../src/lib/bff-proxy.js'

export const dynamic = 'force-dynamic'

export async function PATCH(request, { params }) {
  return bffProxy(request, `/data/dashboard-widgets/${params.id}`, { method: 'PATCH' })
}

export async function DELETE(request, { params }) {
  return bffProxy(request, `/data/dashboard-widgets/${params.id}`, { method: 'DELETE' })
}
