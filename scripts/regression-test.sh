#!/usr/bin/env bash

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
RESET='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
RESULTS=()

record_pass() {
  local name="$1"
  PASS_COUNT=$((PASS_COUNT + 1))
  RESULTS+=("PASS|$name")
  printf "%b[PASS]%b %s\n" "$GREEN" "$RESET" "$name"
}

record_fail() {
  local name="$1"
  local reason="$2"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  RESULTS+=("FAIL|$name|$reason")
  printf "%b[FAIL]%b %s - %s\n" "$RED" "$RESET" "$name" "$reason"
}

run_step() {
  local name="$1"
  shift

  echo ""
  echo "==> $name"
  if "$@"; then
    record_pass "$name"
  else
    record_fail "$name" "command exited non-zero"
  fi
}

check_smoke_server() {
  local base_url="${SMOKE_BASE_URL:-http://localhost:3001}"
  echo "Smoke base URL: $base_url"

  if ! curl -sf "$base_url/health" >/dev/null; then
    echo "Server health check failed at $base_url/health"
    return 1
  fi

  SMOKE_BASE_URL="$base_url" BILLING_ENABLED="${BILLING_ENABLED:-false}" node scripts/smoke-test.js
}

check_schema_drift() {
  echo "Comparing prisma/migrations against configured datasource..."
  npx prisma migrate diff \
    --from-migrations prisma/migrations \
    --to-config-datasource \
    --exit-code
  local code=$?

  if [ "$code" -eq 0 ]; then
    echo "No schema drift detected."
    return 0
  fi

  if [ "$code" -eq 2 ]; then
    echo "Schema drift detected between migrations and datasource."
    return 1
  fi

  echo "Prisma migrate diff failed with exit code $code."
  return 1
}

echo "Running backend regression suite..."

run_step "Unit/Integration tests (npm test)" npm test
run_step "TypeScript compile check (npx tsc --noEmit)" npx tsc --noEmit
run_step "Smoke test against running server" check_smoke_server
run_step "Prisma schema drift check" check_schema_drift

echo ""
echo "================ Regression Summary ================"
printf "Passed: %d\n" "$PASS_COUNT"
printf "Failed: %d\n" "$FAIL_COUNT"

for item in "${RESULTS[@]}"; do
  IFS='|' read -r status name reason <<< "$item"
  if [ "$status" = "PASS" ]; then
    printf "  %bPASS%b %s\n" "$GREEN" "$RESET" "$name"
  else
    printf "  %bFAIL%b %s (%s)\n" "$RED" "$RESET" "$name" "$reason"
  fi
done

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo ""
  printf "%bRegression suite FAILED%b\n" "$RED" "$RESET"
  exit 1
fi

echo ""
printf "%bRegression suite PASSED%b\n" "$GREEN" "$RESET"
exit 0
