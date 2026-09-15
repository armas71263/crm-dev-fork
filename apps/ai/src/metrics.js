// Tiny Prometheus-text-format registry (Phase 7) — zero dependencies on
// purpose: the sandbox is memory-constrained and prom-client buys us nothing
// we can't hand-roll. AGGREGATE metrics only — never per-tenant data (a
// /metrics scrape must not leak tenant identities).

const startedAt = Date.now()
const counters = new Map()   // name|labelkv -> { name, labels, value }
const histograms = new Map() // name -> { name, buckets, counts[], sum, count }

const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

export function incCounter(name, labels = {}, by = 1) {
  const kv = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1))
  const key = name + '|' + kv.map(([k, v]) => `${k}=${String(v)}`).join(',')
  const entry = counters.get(key) || { name, labels: Object.fromEntries(kv), value: 0 }
  entry.value += by
  counters.set(key, entry)
  return entry
}

export function observeDuration(name, seconds, buckets = DEFAULT_BUCKETS) {
  let h = histograms.get(name)
  if (!h) {
    h = { name, buckets, counts: new Array(buckets.length + 1).fill(0), sum: 0, count: 0 }
    histograms.set(name, h)
  }
  // store PER-BUCKET (non-cumulative) counts; renderMetrics cumulates.
  let placed = false
  for (let i = 0; i < buckets.length; i++) {
    if (seconds <= buckets[i]) { h.counts[i]++; placed = true; break }
  }
  if (!placed) h.counts[buckets.length]++
  h.sum += seconds
  h.count++
}

function esc(v) { return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') }

export function renderMetrics({ extra = {} } = {}) {
  const lines = []
  const uptime = (Date.now() - startedAt) / 1000
  lines.push('# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${uptime.toFixed(2)}`)
  for (const [name, value] of Object.entries(extra)) {
    lines.push(`# TYPE ${name} gauge`, `${name} ${value}`)
  }
  const byName = new Map()
  for (const c of counters.values()) {
    if (!byName.has(c.name)) byName.set(c.name, [])
    byName.get(c.name).push(c)
  }
  for (const [name, entries] of byName) {
    lines.push(`# TYPE ${name} counter`)
    for (const e of entries) {
      const labelStr = Object.entries(e.labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',')
      lines.push(labelStr ? `${name}{${labelStr}} ${e.value}` : `${name} ${e.value}`)
    }
  }
  for (const h of histograms.values()) {
    lines.push(`# TYPE ${h.name} histogram`)
    let cumulative = 0
    for (let i = 0; i < h.buckets.length; i++) {
      cumulative += h.counts[i]
      lines.push(`${h.name}_bucket{le="${h.buckets[i]}"} ${cumulative}`)
    }
    cumulative += h.counts[h.buckets.length]
    lines.push(`${h.name}_bucket{le="+Inf"} ${cumulative}`)
    lines.push(`${h.name}_sum ${h.sum.toFixed(6)}`)
    lines.push(`${h.name}_count ${h.count}`)
  }
  return lines.join('\n') + '\n'
}
