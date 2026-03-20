#!/bin/bash
set -uo pipefail

echo "=== Prisma migrate deploy ==="
if npx prisma migrate deploy 2>&1; then
  echo "Migrations applied successfully"
else
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "CRITICAL: prisma migrate deploy FAILED"
  echo "Schema mismatch may cause runtime errors!"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "Attempting manual column fix..."
  # If migration fails, ensure critical columns exist
  node -e "
    const { createClient } = require('@libsql/client');
    const client = createClient({ url: process.env.DATABASE_URL || 'file:/data/nala.db' });
    (async () => {
      try {
        const cols = await client.execute('PRAGMA table_info(User)');
        const names = cols.rows.map(r => r.name);
        if (!names.includes('kycVerified')) {
          await client.execute('ALTER TABLE \"User\" ADD COLUMN \"kycVerified\" BOOLEAN NOT NULL DEFAULT false');
          console.log('[Migration Fix] Added kycVerified column');
        }
        if (!names.includes('kycVerifiedAt')) {
          await client.execute('ALTER TABLE \"User\" ADD COLUMN \"kycVerifiedAt\" DATETIME');
          console.log('[Migration Fix] Added kycVerifiedAt column');
        }
        console.log('[Migration Fix] Column check complete');
      } catch (e) {
        console.error('[Migration Fix] Failed:', e.message);
      }
    })();
  " 2>&1 || echo "WARNING: Manual column fix also failed, continuing..."
fi

echo "=== Configuring fonts for share card rendering ==="
export FONTCONFIG_FILE=/app/assets/fonts.conf
mkdir -p /tmp/fontconfig-cache
fc-cache -f /app/assets 2>/dev/null || true

echo "=== Starting server ==="
exec node dist/index.js
