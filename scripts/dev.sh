#!/usr/bin/env bash
# Dev stack for the managed preview: BFF (JWT mode, live Supabase) + Next.js dev.
# Supervisor pattern: this environment can silently reap long-running children,
# so this script stays in the foreground as a watchdog and restarts whichever
# server stopped answering. Health checks use curl — `ss`/`lsof` are not in
# PATH in the preview runtime. Both processes always run in DEV mode.
set -u
cd "$(dirname "$0")/.."

set -a
source .env
set +a

mkdir -p /tmp/devstack
BFF_LOG=/tmp/devstack/bff.log
NEXT_LOG=/tmp/devstack/next.log

start_bff() {
  pkill -f 'node apps/bff/src/index.js' 2>/dev/null
  sleep 0.5
  setsid node apps/bff/src/index.js < <(sleep infinity) >> "$BFF_LOG" 2>&1 &
  disown
}

start_next() {
  pkill -f 'next dev' 2>/dev/null
  sleep 0.5
  ( cd apps/web && setsid npx next dev < <(sleep infinity) >> "$NEXT_LOG" 2>&1 & )
  disown
}

start_bff
start_next

# Any completed HTTP response (even 3xx/4xx) means the server is alive;
# curl failing to connect or timing out means restart.
while true; do
  sleep 7
  if ! curl -s -m 4 -o /dev/null http://127.0.0.1:4000/health; then
    echo "[dev.sh] $(date +%T) BFF unresponsive — restarting" >> "$BFF_LOG"
    start_bff
  fi
  if ! curl -s -m 4 -o /dev/null http://127.0.0.1:3000/; then
    echo "[dev.sh] $(date +%T) next unresponsive — restarting" >> "$NEXT_LOG"
    start_next
  fi
done
