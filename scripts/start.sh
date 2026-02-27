#!/bin/bash
set -euo pipefail

echo "=== Prisma migrate deploy ==="
npx prisma migrate deploy 2>&1

echo "=== Starting server ==="
exec node dist/index.js
