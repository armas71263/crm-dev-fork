// PostHog Cloud events (Phase 7) — opt-in by construction: without
// POSTHOG_API_KEY no network call is ever made (verified no-op). Server-side
// only; the distinct id is the Supabase user id, never raw PII.
export async function capture(distinctId, event, properties = {}) {
  const key = process.env.POSTHOG_API_KEY
  if (!key) return false
  try {
    const res = await fetch(`${process.env.POSTHOG_HOST || 'https://us.i.posthog.com'}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        event,
        distinct_id: String(distinctId || 'anonymous'),
        properties,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false // analytics must never break a request
  }
}
