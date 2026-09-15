import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose'

// Supabase Auth (GoTrue) verifier. ES256 JWTs, issuer/audience checked, and the
// tenant/company/role claims come from app_metadata — which only the service-role
// key can write, so a client cannot self-assign a tenant.
export function createAuthVerifier({ supabaseUrl, jwks }) {
  const issuer = `${String(supabaseUrl).replace(/\/+$/, '')}/auth/v1`
  const keyset = jwks
    ? createLocalJWKSet(jwks)
    : createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`))

  return {
    mode: 'jwt',
    async verify(token) {
      const { payload } = await jwtVerify(token, keyset, {
        algorithms: ['ES256'],
        issuer,
        audience: 'authenticated',
      })
      const meta = payload.app_metadata || {}
      if (!meta.tenant_id) throw new Error('token missing app_metadata.tenant_id')
      return {
        userId: payload.sub,
        tenantId: meta.tenant_id,
        companyId: meta.company_id || null,
        role: meta.role || 'staff',
      }
    },
  }
}
