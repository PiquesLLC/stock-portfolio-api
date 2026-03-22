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
        // Ensure social platform tables (Post, Comment, Like, SocialNotification)
        await client.execute('CREATE TABLE IF NOT EXISTS \"Post\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"userId\" TEXT NOT NULL, \"content\" TEXT NOT NULL, \"ticker\" TEXT, \"type\" TEXT NOT NULL DEFAULT \\'thought\\', \"attachmentType\" TEXT, \"attachmentData\" TEXT, \"deleted\" BOOLEAN NOT NULL DEFAULT false, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \"updatedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"Post_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE)');
        await client.execute('CREATE INDEX IF NOT EXISTS \"Post_userId_createdAt_idx\" ON \"Post\"(\"userId\", \"createdAt\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"Post_ticker_createdAt_idx\" ON \"Post\"(\"ticker\", \"createdAt\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"Post_createdAt_idx\" ON \"Post\"(\"createdAt\")');
        await client.execute('CREATE TABLE IF NOT EXISTS \"Comment\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"postId\" TEXT NOT NULL, \"userId\" TEXT NOT NULL, \"content\" TEXT NOT NULL, \"deleted\" BOOLEAN NOT NULL DEFAULT false, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"Comment_postId_fkey\" FOREIGN KEY (\"postId\") REFERENCES \"Post\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT \"Comment_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE)');
        await client.execute('CREATE INDEX IF NOT EXISTS \"Comment_postId_createdAt_idx\" ON \"Comment\"(\"postId\", \"createdAt\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"Comment_userId_idx\" ON \"Comment\"(\"userId\")');
        await client.execute('CREATE TABLE IF NOT EXISTS \"Like\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"postId\" TEXT NOT NULL, \"userId\" TEXT NOT NULL, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"Like_postId_fkey\" FOREIGN KEY (\"postId\") REFERENCES \"Post\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT \"Like_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE)');
        await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS \"Like_postId_userId_key\" ON \"Like\"(\"postId\", \"userId\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"Like_postId_idx\" ON \"Like\"(\"postId\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"Like_userId_idx\" ON \"Like\"(\"userId\")');
        await client.execute('CREATE TABLE IF NOT EXISTS \"SocialNotification\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"userId\" TEXT NOT NULL, \"actorId\" TEXT NOT NULL, \"type\" TEXT NOT NULL, \"postId\" TEXT, \"message\" TEXT NOT NULL, \"read\" BOOLEAN NOT NULL DEFAULT false, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"SocialNotification_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT \"SocialNotification_actorId_fkey\" FOREIGN KEY (\"actorId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE)');
        await client.execute('CREATE INDEX IF NOT EXISTS \"SocialNotification_userId_read_createdAt_idx\" ON \"SocialNotification\"(\"userId\", \"read\", \"createdAt\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"SocialNotification_userId_createdAt_idx\" ON \"SocialNotification\"(\"userId\", \"createdAt\")');
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
