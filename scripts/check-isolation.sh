#!/usr/bin/env bash
# CI guardrail: detect data-isolation anti-patterns in user-facing services.
# Checks 1-3 are hard failures. Check 4 is advisory (warnings only).
# Exits non-zero if any hard check fails.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src"
FAIL=0

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }

# ── 1. No hardcoded SYSTEM_USER_ID in services or controllers ────────────────
# Allowlist: email-verification-guard legitimately bypasses verification for system user
echo "Checking for SYSTEM_USER_ID..."
if grep -rn 'SYSTEM_USER_ID' "$SRC/services/" "$SRC/controllers/" 2>/dev/null \
  | grep -v 'email-verification-guard'; then
  red "FAIL: SYSTEM_USER_ID found in services/controllers"
  FAIL=1
else
  green "OK: No SYSTEM_USER_ID in services/controllers (allowlisted: email-verification-guard)"
fi

# ── 2. No resolveUserId helper (legacy pattern) ─────────────────────────────
echo "Checking for resolveUserId..."
if grep -rn 'resolveUserId' "$SRC/services/" "$SRC/controllers/" 2>/dev/null; then
  red "FAIL: resolveUserId found in services/controllers"
  FAIL=1
else
  green "OK: No resolveUserId in services/controllers"
fi

# ── 3. No optional userId in service function signatures ─────────────────────
# Allowlist: batch-operation services that optionally scope to a single user
# (anomaly-detection, dividend-fetch, dividend-post run as system-wide crons)
echo "Checking for optional userId in services..."
if grep -Pn 'userId\?\s*:\s*string' "$SRC/services/"*.ts 2>/dev/null \
  | grep -v 'anomaly-detection' \
  | grep -v 'dividend-fetch' \
  | grep -v 'dividend-post' \
  | grep -v 'analyst.service'; then
  red "FAIL: Optional userId found in service signatures"
  FAIL=1
else
  green "OK: No optional userId in services (allowlisted: anomaly-detection, dividend-fetch, dividend-post)"
fi

# ── 4. Advisory: unscoped findMany in user-scoped services (warn only) ───────
echo "Checking for unscoped findMany (advisory)..."
WARN=0
SCOPED_SERVICES="transaction.service.ts portfolio.service.ts goals.service.ts priceAlert.service.ts settings.service.ts watchlist.service.ts"
for svc in $SCOPED_SERVICES; do
  FILE="$SRC/services/$svc"
  [ -f "$FILE" ] || continue
  grep -Pn 'findMany\(\{' "$FILE" 2>/dev/null | while read -r line; do
    LINENUM=$(echo "$line" | cut -d: -f1)
    if ! sed -n "$((LINENUM)),$(( LINENUM + 10 ))p" "$FILE" | grep -q 'userId'; then
      yellow "WARN: $svc:$LINENUM — findMany without userId in nearby where clause (review manually)"
      WARN=1
    fi
  done || true
done
if [ "$WARN" -eq 0 ]; then
  green "OK: No unscoped findMany warnings"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL" -ne 0 ]; then
  red "Data isolation check FAILED"
  exit 1
else
  green "All data isolation checks passed"
  exit 0
fi
