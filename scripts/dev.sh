#!/usr/bin/env bash
# Dev stack for the managed preview: BFF in JWT mode (live Supabase) + Next.js.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
source .env
set +a

# A stale BFF from a previous preview run would hold port 4000.
pkill -f 'node apps/bff/src/index.js' 2>/dev/null || true
sleep 1

node apps/bff/src/index.js &
BFF_PID=$!
trap 'kill $BFF_PID 2>/dev/null || true' EXIT

cd apps/web
# next dev exits gracefully when stdin reaches EOF — keep stdin open forever.
exec npx next dev < <(sleep infinity)
