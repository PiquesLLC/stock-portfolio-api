#!/bin/bash
set -uo pipefail

# Ensure critical tables exist BEFORE resolving migrations.
# Migrations marked as "applied" require the tables to actually exist.
echo "=== Ensuring critical tables ==="
node -e "
  const { createClient } = require('@libsql/client');
  const client = createClient({ url: process.env.DATABASE_URL || 'file:/data/nala.db' });
  (async () => {
    try {
      await client.execute('CREATE TABLE IF NOT EXISTS \"UserBlock\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"blockerId\" TEXT NOT NULL, \"blockedId\" TEXT NOT NULL, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"UserBlock_blockerId_fkey\" FOREIGN KEY (\"blockerId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT \"UserBlock_blockedId_fkey\" FOREIGN KEY (\"blockedId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE)');
      await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS \"UserBlock_blockerId_blockedId_key\" ON \"UserBlock\"(\"blockerId\", \"blockedId\")');
      await client.execute('CREATE TABLE IF NOT EXISTS \"ValueRadarCache\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"ticker\" TEXT NOT NULL, \"avgPE\" REAL, \"peHistoryJson\" TEXT, \"yearsOfData\" INTEGER, \"lastFetchedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \"updatedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
      await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS \"ValueRadarCache_ticker_key\" ON \"ValueRadarCache\"(\"ticker\")');
      await client.execute('CREATE TABLE IF NOT EXISTS \"RefreshRotationCache\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"oldTokenHash\" TEXT NOT NULL, \"newTokenCipher\" TEXT NOT NULL, \"payloadJson\" TEXT NOT NULL, \"userId\" TEXT NOT NULL, \"family\" TEXT NOT NULL, \"consumed\" BOOLEAN NOT NULL DEFAULT false, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"RefreshRotationCache_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE)');
      await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS \"RefreshRotationCache_oldTokenHash_key\" ON \"RefreshRotationCache\"(\"oldTokenHash\")');
      await client.execute('CREATE INDEX IF NOT EXISTS \"RefreshRotationCache_userId_idx\" ON \"RefreshRotationCache\"(\"userId\")');
      await client.execute('CREATE INDEX IF NOT EXISTS \"RefreshRotationCache_createdAt_idx\" ON \"RefreshRotationCache\"(\"createdAt\")');
      await client.execute('CREATE TABLE IF NOT EXISTS \"PendingEmailChange\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"userId\" TEXT NOT NULL, \"newEmail\" TEXT NOT NULL, \"codeHash\" TEXT NOT NULL, \"expiresAt\" DATETIME NOT NULL, \"usedAt\" DATETIME, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"PendingEmailChange_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE)');
      await client.execute('CREATE INDEX IF NOT EXISTS \"PendingEmailChange_userId_idx\" ON \"PendingEmailChange\"(\"userId\")');
      await client.execute('CREATE INDEX IF NOT EXISTS \"PendingEmailChange_expiresAt_idx\" ON \"PendingEmailChange\"(\"expiresAt\")');
      // CreatorWalletLedger DB-level idempotency (migration 20260527_add_ledger_idempotency).
      // Runs the same backfills + UNIQUE INDEX as the migration in case
      // `prisma migrate deploy` fails for any reason. Subsequent boots are no-ops:
      // the UPDATEs only match rows still in the legacy shape, and the index
      // uses IF NOT EXISTS.
      try {
        await client.execute(\"UPDATE \\\"CreatorWalletLedger\\\" SET description = 'payout:' || rowid WHERE type = 'payout' AND description = 'Payout requested'\");
        await client.execute(\"UPDATE \\\"CreatorWalletLedger\\\" SET description = description || ':' || rowid WHERE description IN ('admin_fix:initial_payment', 'admin_fix:platform_fee')\");
        await client.execute(\"UPDATE \\\"CreatorWalletLedger\\\" SET description = description || ':dup:' || rowid WHERE id IN (SELECT l1.id FROM \\\"CreatorWalletLedger\\\" l1 JOIN \\\"CreatorWalletLedger\\\" l2 ON l1.\\\"creatorUserId\\\" = l2.\\\"creatorUserId\\\" AND l1.description = l2.description AND l1.description IS NOT NULL AND l1.rowid > l2.rowid)\");
        await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS \"creator_wallet_ledger_creator_desc_unique\" ON \"CreatorWalletLedger\"(\"creatorUserId\", \"description\")');
      } catch (e) {
        console.warn('[Startup] Ledger idempotency setup non-fatal error:', e.message);
      }
      console.log('[Startup] Critical tables ensured');
    } catch (e) { console.warn('[Startup] Table ensure failed:', e.message); }
  })();
" 2>&1 || true

# Resolve stuck/failed migrations by marking them as applied.
echo "=== Resolving stuck migrations ==="
npx prisma migrate resolve --rolled-back 20260319_add_post_attachments 2>&1 || true
npx prisma migrate resolve --applied 20260319_add_social_platform 2>&1 || true
npx prisma migrate resolve --applied 20260320_add_appeals 2>&1 || true
npx prisma migrate resolve --applied 20260320_add_content_moderation 2>&1 || true
npx prisma migrate resolve --applied 20260323_creator_visibility_defaults 2>&1 || true
npx prisma migrate resolve --applied 20260324_add_monitoring_reports 2>&1 || true
npx prisma migrate resolve --applied 20260324_add_stripe_indexes 2>&1 || true
npx prisma migrate resolve --applied 20260325_add_user_block 2>&1 || true
npx prisma migrate resolve --applied 20260327_add_value_radar_cache 2>&1 || true
npx prisma migrate resolve --applied 20260513_add_refresh_rotation_cache 2>&1 || true
npx prisma migrate resolve --applied 20260513_add_pending_email_change 2>&1 || true
npx prisma migrate resolve --applied 20260527_add_ledger_idempotency 2>&1 || true

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
        // Ensure UserBlock table
        await client.execute('CREATE TABLE IF NOT EXISTS \"UserBlock\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"blockerId\" TEXT NOT NULL, \"blockedId\" TEXT NOT NULL, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"UserBlock_blockerId_fkey\" FOREIGN KEY (\"blockerId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT \"UserBlock_blockedId_fkey\" FOREIGN KEY (\"blockedId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE)');
        await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS \"UserBlock_blockerId_blockedId_key\" ON \"UserBlock\"(\"blockerId\", \"blockedId\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"UserBlock_blockerId_idx\" ON \"UserBlock\"(\"blockerId\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"UserBlock_blockedId_idx\" ON \"UserBlock\"(\"blockedId\")');
        // Ensure ValueRadarCache table
        await client.execute('CREATE TABLE IF NOT EXISTS \"ValueRadarCache\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"ticker\" TEXT NOT NULL, \"avgPE\" REAL, \"peHistoryJson\" TEXT, \"yearsOfData\" INTEGER, \"lastFetchedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \"updatedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
        await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS \"ValueRadarCache_ticker_key\" ON \"ValueRadarCache\"(\"ticker\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"ValueRadarCache_ticker_idx\" ON \"ValueRadarCache\"(\"ticker\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"ValueRadarCache_lastFetchedAt_idx\" ON \"ValueRadarCache\"(\"lastFetchedAt\")');
        // Ensure RefreshRotationCache table (May 13 migration — refresh-token rotation cache)
        await client.execute('CREATE TABLE IF NOT EXISTS \"RefreshRotationCache\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"oldTokenHash\" TEXT NOT NULL, \"newTokenCipher\" TEXT NOT NULL, \"payloadJson\" TEXT NOT NULL, \"userId\" TEXT NOT NULL, \"family\" TEXT NOT NULL, \"consumed\" BOOLEAN NOT NULL DEFAULT false, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"RefreshRotationCache_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE)');
        await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS \"RefreshRotationCache_oldTokenHash_key\" ON \"RefreshRotationCache\"(\"oldTokenHash\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"RefreshRotationCache_userId_idx\" ON \"RefreshRotationCache\"(\"userId\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"RefreshRotationCache_createdAt_idx\" ON \"RefreshRotationCache\"(\"createdAt\")');
        // Ensure PendingEmailChange table (May 13 migration — two-step email change)
        await client.execute('CREATE TABLE IF NOT EXISTS \"PendingEmailChange\" (\"id\" TEXT NOT NULL PRIMARY KEY, \"userId\" TEXT NOT NULL, \"newEmail\" TEXT NOT NULL, \"codeHash\" TEXT NOT NULL, \"expiresAt\" DATETIME NOT NULL, \"usedAt\" DATETIME, \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"PendingEmailChange_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"User\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE)');
        await client.execute('CREATE INDEX IF NOT EXISTS \"PendingEmailChange_userId_idx\" ON \"PendingEmailChange\"(\"userId\")');
        await client.execute('CREATE INDEX IF NOT EXISTS \"PendingEmailChange_expiresAt_idx\" ON \"PendingEmailChange\"(\"expiresAt\")');
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

echo "=== Seeding billionaire data ==="
node scripts/seed-billionaires.js 2>&1 || echo "WARNING: Billionaire seed failed, continuing..."

echo "=== Starting server ==="
exec node dist/index.js
