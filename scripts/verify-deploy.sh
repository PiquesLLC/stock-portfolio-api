#!/bin/bash
# Post-deploy smoke test — verifies production data quality after a deploy.
# Run this immediately after `railway up --detach` completes.
#
# Checks:
#   1. /health returns 200
#   2. /market/prices for baseline tickers returns all prices
#   3. /market/heatmap?period=1D&index=SP500 has <25% zeros
#
# Exit 0 = all checks passed. Exit 1 = regression detected, investigate/rollback.

set -u

API_URL="${API_URL:-https://stock-portfolio-api-production.up.railway.app}"
WAIT_SECONDS="${WAIT_SECONDS:-180}"  # Railway build usually finishes in ~3 min
ZERO_THRESHOLD_PCT=25                 # max % of heatmap tickers allowed to show 0.00%
BASELINE_TICKERS="AAPL,MSFT,NVDA,TSLA,GOOGL"

# ANSI colors (falls back to plain text if terminal doesn't support them)
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

fail_count=0
warn_count=0

echo ""
echo "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo "${BOLD}  Post-deploy verification${RESET}"
echo "${BOLD}  Target: ${API_URL}${RESET}"
echo "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo "Waiting ${WAIT_SECONDS}s for Railway build to finish..."
sleep "$WAIT_SECONDS"

# ─── Check 1: Health endpoint ────────────────────────────────────────────────
echo -n "1. /health              ... "
health_status=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "${API_URL}/health" || echo "000")
if [ "$health_status" = "200" ]; then
  echo "${GREEN}OK${RESET} (200)"
else
  echo "${RED}FAIL${RESET} (HTTP $health_status)"
  fail_count=$((fail_count + 1))
fi

# ─── Check 2: Baseline ticker prices ─────────────────────────────────────────
echo -n "2. /market/prices       ... "
prices_response=$(curl -s -m 15 "${API_URL}/market/prices?tickers=${BASELINE_TICKERS}" || echo '{"prices":{}}')
returned_count=$(echo "$prices_response" | node -e "
try {
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  console.log(Object.keys(d.prices || {}).length);
} catch { console.log(0); }
")
expected_count=$(echo "$BASELINE_TICKERS" | tr ',' '\n' | wc -l | tr -d ' ')
if [ "$returned_count" = "$expected_count" ]; then
  echo "${GREEN}OK${RESET} (${returned_count}/${expected_count} tickers)"
else
  echo "${RED}FAIL${RESET} (${returned_count}/${expected_count} tickers returned)"
  fail_count=$((fail_count + 1))
fi

# ─── Check 3: Heatmap zero-rate ──────────────────────────────────────────────
echo -n "3. /market/heatmap      ... "
heatmap_response=$(curl -s -m 20 "${API_URL}/market/heatmap?period=1D&index=SP500" || echo '{"sectors":[]}')
heatmap_stats=$(echo "$heatmap_response" | node -e "
try {
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const all = (d.sectors || []).flatMap(s => (s.subSectors || []).flatMap(ss => ss.stocks || []));
  const zeros = all.filter(s => s.changePercent === 0).length;
  const pct = all.length > 0 ? Math.round((zeros / all.length) * 100) : 100;
  console.log(zeros + ' ' + all.length + ' ' + pct);
} catch { console.log('0 0 100'); }
")
read -r zeros total pct <<< "$heatmap_stats"
if [ "$total" = "0" ]; then
  echo "${RED}FAIL${RESET} (no heatmap data returned)"
  fail_count=$((fail_count + 1))
elif [ "$pct" -gt "$ZERO_THRESHOLD_PCT" ]; then
  echo "${RED}FAIL${RESET} (${zeros}/${total} stocks at 0%, ${pct}% > ${ZERO_THRESHOLD_PCT}% threshold)"
  fail_count=$((fail_count + 1))
else
  echo "${GREEN}OK${RESET} (${zeros}/${total} zeros, ${pct}%)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
if [ "$fail_count" -gt 0 ]; then
  echo "${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo "${RED}${BOLD}  🚨 REGRESSION DETECTED — ${fail_count} check(s) failed${RESET}"
  echo "${RED}${BOLD}  Consider rolling back the most recent deploy.${RESET}"
  echo "${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  exit 1
else
  echo "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo "${GREEN}${BOLD}  ✓ Deploy verified — all checks passed${RESET}"
  echo "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  exit 0
fi
