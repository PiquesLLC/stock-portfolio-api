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
        if (!names.includes('suspended')) {
          await client.execute('ALTER TABLE \"User\" ADD COLUMN \"suspended\" BOOLEAN NOT NULL DEFAULT false');
          console.log('[Migration Fix] Added suspended column');
        }
        if (!names.includes('suspendedAt')) {
          await client.execute('ALTER TABLE \"User\" ADD COLUMN \"suspendedAt\" DATETIME');
          console.log('[Migration Fix] Added suspendedAt column');
        }
        // Ensure ContentStrike table
        await client.execute('CREATE TABLE IF NOT EXISTS \"ContentStrike\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"userId\" TEXT NOT NULL, \"reason\" TEXT NOT NULL, \"details\" TEXT, \"issuedBy\" TEXT NOT NULL, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"ContentStrike_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE)');
        await client.execute('CREATE INDEX IF NOT EXISTS \"ContentStrike_userId_idx\" ON \"ContentStrike\"(\"userId\")');
        // Ensure Appeal table
        await client.execute('CREATE TABLE IF NOT EXISTS \"Appeal\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"strikeId\" TEXT NOT NULL, \"userId\" TEXT NOT NULL, \"reason\" TEXT NOT NULL, \"status\" TEXT NOT NULL DEFAULT \\'pending\\', \"adminNotes\" TEXT, \"resolvedBy\" TEXT, \"resolvedAt\" DATETIME, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \"updatedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"Appeal_strikeId_fkey\" FOREIGN KEY (\"strikeId\") REFERENCES \"ContentStrike\" (\"id\") ON DELETE RESTRICT ON UPDATE CASCADE, CONSTRAINT \"Appeal_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"User\" (\"id\") ON DELETE RESTRICT ON UPDATE CASCADE)');
        await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS \"Appeal_strikeId_key\" ON \"Appeal\"(\"strikeId\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"Appeal_userId_idx\" ON \"Appeal\"(\"userId\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"Appeal_status_idx\" ON \"Appeal\"(\"status\")');
        console.log('[Migration Fix] Column + table check complete');
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
