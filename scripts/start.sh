#!/bin/bash
set -euo pipefail

echo "=== Prisma migrate deploy ==="
npx prisma migrate deploy 2>&1

echo "=== One-time: delete test user ==="
node scripts/delete-test-user.js 2>&1 || echo "delete-test-user script skipped or failed (non-fatal)"

echo "=== Starting server ==="
exec node dist/index.js
