#!/usr/bin/env bash
# CI smoke test: build, start server, verify /health responds, shut down.
# Catches startup crashes, missing imports, broken builds.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

# Minimal env for non-production startup
export JWT_SECRET="ci-smoke-test-secret-not-real"
export DATABASE_URL="file:./ci-smoke.db"
export NODE_ENV="development"
export BILLING_ENABLED="false"
export PLAID_ENABLED="false"
export PORT="3099"

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f ci-smoke.db ci-smoke.db-journal 2>/dev/null || true
}
trap cleanup EXIT

# 1. Build TypeScript
echo "Building TypeScript..."
npx tsc
green "Build OK"

# 2. Apply migrations to create schema
echo "Applying migrations..."
npx prisma migrate deploy 2>&1
green "Migrations OK"

# 3. Start server in background
echo "Starting server on port $PORT..."
node dist/index.js &
SERVER_PID=$!

# 4. Wait for server to be ready (up to 15 seconds)
echo "Waiting for server..."
READY=0
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

if [ "$READY" -eq 0 ]; then
  red "FAIL: Server did not become ready within 15 seconds"
  exit 1
fi

# 5. Verify /health response
echo "Checking /health..."
RESPONSE=$(curl -sf "http://localhost:$PORT/health")
STATUS=$(echo "$RESPONSE" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try { console.log(JSON.parse(d).status); } catch { console.log('parse_error'); }
  });
")

if [ "$STATUS" != "ok" ]; then
  red "FAIL: /health returned status='$STATUS', expected 'ok'"
  red "Response: $RESPONSE"
  exit 1
fi

green "Smoke test PASSED — server started and /health returned ok"
