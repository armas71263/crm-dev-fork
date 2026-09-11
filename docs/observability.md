# Observability runbook (Phase 7)

## What runs in this repo (live)
- **Prometheus metrics** (zero-dependency, hand-rolled text format):
  - BFF `:4000/metrics` — `http_requests_total{route,status}`, `http_request_duration_seconds` histogram, `health_checks_total`, heap gauge. Route labels use router paths (ids normalized), NEVER tenant identifiers — a scrape must not leak tenant data.
  - AI `:5000/metrics` — `ai_chat_requests_total{route}`, `ai_tokens_total{provider}`, `agent_tasks_total{status,type}`, heap gauge.
- **Deep health** `:4000/health/deep` — one JSON matrix for db + ai + predictions with per-check latency. This is the endpoint any uptime monitor polls.
- **Ops screen** (`/ops`, staff) — deep health + the agent task queue.
- **PostHog Cloud** (opt-in): BFF server events (`suggestion_accepted`, `suggestion_rejected`) via `POSTHOG_API_KEY`. Without the key `capture()` makes NO network call — verified no-op.

## Activate PostHog Cloud (needs your account)
1. Create a PostHog Cloud project, copy the project API key.
2. Add to `.env`: `POSTHOG_API_KEY=phc_...` (and `POSTHOG_HOST` if EU: `https://eu.i.posthog.com`).
3. Restart `./scripts/dev.sh`; accept a suggestion and confirm the event in the PostHog activity feed.
4. Client-side events (optional, for product analytics): add `posthog-js` in `apps/web` behind `NEXT_PUBLIC_POSTHOG_KEY` — not installed now to keep the sandbox lean.

## Uptime monitoring (Uptime Kuma — production)
Uptime Kuma is a single container and would fit this dev sandbox only marginally;
run it where your production stack lives:
```yaml
# docker-compose.monitoring.yml
services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    ports: ["3001:3001"]
    volumes: ["kuma:/data"]
    restart: unless-stopped
volumes: { kuma: {} }
```
Then add an HTTP monitor for `https://<bff-host>/health/deep` (interval 60s, keyword `"status":"ok"`).

## SigNoz (traces + metric dashboards — production hardware)
SigNoz's stack (ClickHouse, query-service, frontend, otel-collector, alertmanager)
needs ~4 vCPU/8GB — it cannot coexist with the dev sandbox (1.9GB). Production steps:
1. `git clone https://github.com/SigNoz/signoz.git && cd deploy && ./install.sh`
2. Prometheus scrape config (the collector ships our format as-is):
```yaml
scrape_configs:
  - job_name: rubbertrack
    static_configs:
      - targets: ['bff:4000', 'ai:5000']
    metrics_path: /metrics
```
3. OTel SDK wiring (per service, env-driven): set `OTEL_EXPORTER_OTLP_ENDPOINT=<signoz-host>:4317` and add the `@opentelemetry/sdk-node` auto-instrumentations entrypoint in `apps/bff` and `apps/ai` — the BFF→AI→DB trace then appears in SigNoz. This wiring is deliberately NOT pre-installed: it is dead code without a collector.
