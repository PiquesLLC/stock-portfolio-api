#!/bin/bash
set -euo pipefail

echo "=== Prisma migration baseline ==="
npx prisma migrate resolve --applied 0001_baseline 2>&1 || echo "[start.sh] resolve exited $? (ok if already resolved)"

echo "=== Cleaning orphaned migration records ==="
node scripts/clean-migration-history.js 2>&1

echo "=== Prisma migrate deploy ==="
if npx prisma migrate deploy 2>&1; then
  echo "[start.sh] migrate deploy succeeded"
else
  echo "[start.sh] migrate deploy failed (exit $?), falling back to db push"
  npx prisma db push 2>&1
fi

echo "=== Starting server ==="
exec node dist/index.js
