#!/usr/bin/env bash
# Lint guard: ensure no test file uses a hardcoded rateLimiter mock.
# The correct pattern uses importOriginal() to dynamically replace all exports.
# Hardcoded mocks (listing individual limiters) go stale when new exports are added.

set -euo pipefail

BAD_PATTERN='vi\.mock\(.*/rateLimiter.*\{[^}]*(Limiter|passthrough):'

HITS=$(grep -Ern "$BAD_PATTERN" src/__tests__/ || true)

if [ -n "$HITS" ]; then
  echo "ERROR: Found hardcoded rateLimiter mock(s). Use the dynamic pattern instead:"
  echo ""
  echo "  vi.mock('../middleware/rateLimiter', async (importOriginal) => {"
  echo "    const actual = (await importOriginal()) as Record<string, unknown>;"
  echo "    const passthrough = (_req: any, _res: any, next: any) => next();"
  echo "    return Object.fromEntries("
  echo "      Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? passthrough : v]),"
  echo "    );"
  echo "  });"
  echo ""
  echo "Offending files:"
  echo "$HITS"
  exit 1
fi

echo "OK: All rateLimiter mocks use the dynamic pattern."
