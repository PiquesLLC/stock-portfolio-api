#!/bin/bash
set -euo pipefail

echo "=== Prisma migrate deploy ==="
npx prisma migrate deploy 2>&1 || echo "WARNING: prisma migrate deploy had issues, continuing..."

echo "=== Configuring fonts for share card rendering ==="
export FONTCONFIG_FILE=/app/assets/fonts.conf
mkdir -p /tmp/fontconfig-cache
fc-cache -f /app/assets 2>/dev/null || true

echo "=== Starting server ==="
exec node dist/index.js
