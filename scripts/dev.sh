#!/usr/bin/env bash
# Dev stack for the managed preview: BFF (JWT mode, live Supabase) + AI service
# + Next.js dev. Supervisor pattern: this environment can silently reap
# long-running children, so this script stays in the foreground as a watchdog
# and restarts whichever server stopped answering. Health checks use curl —
# `ss`/`lsof` are not in PATH in the preview runtime. POSIX-safe starts: no
# `disown`, no process substitution — the platform runs this via `sh -lc`.
set -u
cd "$(dirname "$0")/.."

set -a
source .env
set +a

mkdir -p /tmp/devstack
BFF_LOG=/tmp/devstack/bff.log
AI_LOG=/tmp/devstack/ai.log
NEXT_LOG=/tmp/devstack/next.log

start_bff() {
  pkill -f 'node apps/bff/src/index.js' 2>/dev/null
  sleep 0.5
  setsid node apps/bff/src/index.js < /dev/null >> "$BFF_LOG" 2>&1 &
}

# The BFF proxies /ai/* to the AI service (planner→tools→synthesize, SSE) —
# without it the Assistant and Insights screens are dead endpoints.
start_ai() {
  pkill -f 'node apps/ai/src/index.js' 2>/dev/null
  sleep 0.5
  setsid node apps/ai/src/index.js < /dev/null >> "$AI_LOG" 2>&1 &
}

# Predictions service (Phase 5): tenant-series forecasting on :5100.
start_predictions() {
  pkill -f 'uvicorn main:app' 2>/dev/null
  sleep 0.5
  ( cd apps/predictions && setsid .venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 5100 < /dev/null >> /tmp/devstack/predictions.log 2>&1 & )
}

start_next() {
  pkill -f 'next dev' 2>/dev/null
  sleep 0.5
  ( cd apps/web && setsid npx next dev < /dev/null >> "$NEXT_LOG" 2>&1 & )
}

start_bff
start_ai
start_predictions
start_next

# Any completed HTTP response (even 3xx/4xx) means the server is alive;
# curl failing to connect or timing out means restart.
while true; do
  sleep 7
  if ! curl -s -m 4 -o /dev/null http://127.0.0.1:5000/health; then
    echo "[dev.sh] $(date +%T) AI unresponsive — restarting" >> "$AI_LOG"
    start_ai
  fi
  if ! curl -s -m 4 -o /dev/null http://127.0.0.1:4000/health; then
    echo "[dev.sh] $(date +%T) BFF unresponsive — restarting" >> "$BFF_LOG"
    start_bff
  fi
  if ! curl -s -m 4 -o /dev/null http://127.0.0.1:5100/health; then
    echo "[dev.sh] $(date +%T) predictions unresponsive — restarting" >> /tmp/devstack/predictions.log
    start_predictions
  fi
  if ! curl -s -m 4 -o /dev/null http://127.0.0.1:3000/; then
    echo "[dev.sh] $(date +%T) next unresponsive — restarting" >> "$NEXT_LOG"
    start_next
  fi
done
