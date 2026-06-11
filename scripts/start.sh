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
      // Partial unique index: at most one pending payout per creator
      // (migration 20260527_add_payout_pending_unique). Mirrors the migration
      // in case prisma migrate deploy fails. Idempotent on subsequent boots.
      //
      // Pre-clean: if duplicate pending rows exist from before the constraint
      // (kill switch was off historically, or a TOCTOU did once fire), the
      // CREATE UNIQUE INDEX would fail and we'd silently keep running WITHOUT
      // the constraint. Mark all-but-the-oldest pending row per-creator as
      // 'failed' first. The compensating earning entry is intentionally NOT
      // written here — that would require knowing which payouts actually
      // initiated a Stripe transfer vs. which were stuck pre-transfer. Ops can
      // backfill manually after inspecting CreatorPayout history; the failure
      // status alone is enough to unblock the index creation.
      try {
        const dupResult = await client.execute(\"UPDATE \\\"CreatorPayout\\\" SET status = 'failed' WHERE status = 'pending' AND rowid NOT IN (SELECT MIN(rowid) FROM \\\"CreatorPayout\\\" WHERE status = 'pending' GROUP BY \\\"creatorUserId\\\")\");
        if (dupResult.rowsAffected > 0) {
          console.error('[Startup] WARNING: marked ' + dupResult.rowsAffected + ' duplicate pending CreatorPayout rows as failed to allow unique-index creation. Manual ledger reconciliation may be required.');
        }
        await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS \"creator_payout_pending_unique\" ON \"CreatorPayout\"(\"creatorUserId\") WHERE \"status\" = \\'pending\\'');
      } catch (e) {
        // Elevated to error (was warn) so this is visible in any log aggregator.
        // The constraint is critical for payout safety — losing it silently is
        // worse than crashing the boot.
        console.error('[Startup] CRITICAL: Payout pending unique-index setup failed:', e.message);
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
npx prisma migrate resolve --applied 20260527_add_payout_pending_unique 2>&1 || true

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
        // Ensure EmailOtpCode.purpose column (migration 20260610135312_otp_purpose —
        // single-purpose OTP codes; without it the new consumers query a missing
        // column and ALL OTP flows 500). Retire pre-purpose unconsumed codes the
        // first time the column is added, mirroring the real migration.
        const otpCols = await client.execute('PRAGMA table_info(EmailOtpCode)');
        const otpNames = otpCols.rows.map(r => r.name);
        if (!otpNames.includes('purpose')) {
          await client.execute('ALTER TABLE \"EmailOtpCode\" ADD COLUMN \"purpose\" TEXT NOT NULL DEFAULT \\'legacy\\'');
          await client.execute('UPDATE \"EmailOtpCode\" SET \"usedAt\" = CURRENT_TIMESTAMP WHERE \"usedAt\" IS NULL');
          console.log('[Migration Fix] Added EmailOtpCode.purpose column (+retired pre-purpose codes)');
        }
        await client.execute('CREATE INDEX IF NOT EXISTS \"EmailOtpCode_userId_purpose_idx\" ON \"EmailOtpCode\"(\"userId\", \"purpose\")');
        console.log('[Migration Fix] Column + table check complete');
      } catch (e) {
        console.error('[Migration Fix] Failed:', e.message);
      }
    })();
  " 2>&1 || echo "WARNING: Manual column fix also failed, continuing..."
fi

# Pre-MIG-1 hygiene: ensure the v2 chart-of-accounts is fully seeded BEFORE
# the backfill runs. Without this guard, the G6 admin_fix mapper would
# fail with a FK violation on the first row because `adjustment:platform`
# is a new account introduced alongside G6. Seed is idempotent — re-runs
# are a no-op for existing accounts. Only invoked when V2_RUN_BACKFILL_ONCE
# is set so steady-state boots don't pay the seed-script cost.
if [ "${V2_RUN_BACKFILL_ONCE:-}" = "true" ] && [ -n "${V2_DATABASE_URL:-}" ]; then
  echo "=== Pre-MIG-1: ensuring v2 system accounts (idempotent seed) ==="
  npx ts-node prisma-v2/seed.ts 2>&1 | sed 's/^/[v2-seed] /' || echo "[v2-seed] WARN: seed failed — MIG-1 may FK-violate. Investigate before unblocking."
fi

# Clean up the previous MIG-1 marker (-v1) once the new marker (-v2) is in
# use. Avoids long-term volume clutter for future operators inspecting
# /data. No-op if the file is already gone.
#
# OPS NOTE: this rm runs on EVERY boot. Do NOT manually re-arm the -v1
# marker by renaming a -v2 marker back — the boot will silently nuke it.
# To force a backfill re-run after a future mapper bump, choose a NEW
# marker name (e.g., -v3) and update the check above.
rm -f /data/.mig-1-completed-v1 2>/dev/null || true

# Optional one-shot MIG-1 backfill: v1 CreatorWalletLedger → v2 double-entry
# ledger. Gated by V2_RUN_BACKFILL_ONCE=true so it only runs when ops flips
# the env var. Backgrounded so it cannot block the healthcheck (railway.json
# healthcheckTimeout=300s; large v1 datasets could easily exceed that under
# the per-group sequential awaits in mig-1-backfill.ts).
#
# Marker: /data/.mig-1-completed-v2 — versioned so a future re-run after the
# G6 admin_fix mapper lands can use -v2 without manually deleting the old
# marker on the persistent volume.
#
# Logs go BOTH to Railway's log stream (tee + sed prefix, inherited by
# node after the `exec` at the bottom of this script) AND to
# /data/mig-1.log so we can `tail` the prior run's summary on subsequent
# boots even after the log buffer rotates out.
#
# Idempotency safety net: MIG-1's eventGroupIds are deterministic SHA-256
# hashes of v1 keys, so postTransaction would dedup anyway. A mid-backfill
# crash + restart is therefore safe to re-run once the marker is cleared.
echo "=== Optional: MIG-1 v2 backfill (gated by V2_RUN_BACKFILL_ONCE) ==="
if [ "${V2_RUN_BACKFILL_ONCE:-}" = "true" ]; then
  if [ -z "${V2_DATABASE_URL:-}" ]; then
    echo "[MIG-1] SKIP: V2_DATABASE_URL is not set; backfill cannot run without v2 connection."
  elif [ -f /data/.mig-1-completed-v2 ]; then
    echo "[MIG-1] Marker /data/.mig-1-completed-v2 present — skipping."
    if [ -f /data/mig-1.log ]; then
      echo "[MIG-1] Previous run tail (last 30 lines of /data/mig-1.log):"
      tail -30 /data/mig-1.log | sed 's/^/[MIG-1-log] /' || true
    fi
  else
    echo "[MIG-1] Starting backfill in background — output with [MIG-1] prefix below + persistent copy at /data/mig-1.log..."
    (
      NALA_ALLOW_MIGRATION_BACKFILL=true npx ts-node scripts/mig-1-backfill.ts --apply --deferred-out /data/mig-1-deferred.csv 2>&1 | tee /data/mig-1.log | sed 's/^/[MIG-1] /'
      exit_code=${PIPESTATUS[0]:-1}
      if [ "$exit_code" = "0" ]; then
        touch /data/.mig-1-completed-v2
        echo "[MIG-1] OK — exit 0; marker set at /data/.mig-1-completed-v2."
      else
        echo "[MIG-1] CRITICAL: backfill exited code $exit_code — marker NOT set; will retry on next boot."
      fi
    ) &
    disown 2>/dev/null || true
    echo "[MIG-1] Backgrounded (PID $!) — proceeding to start the server."
  fi
else
  echo "[MIG-1] V2_RUN_BACKFILL_ONCE not 'true' — skipping."
fi

# Optional one-shot pre-cutover gate: runs the v1↔v2 reconciliation in
# --gate mode and reports. Exit code is logged but does NOT crash the
# container (the start.sh `set -uo pipefail` doesn't trigger because we
# explicitly check the exit status).
#
# Use this to verify "7-day clean streak" milestones — set
# V2_RUN_GATE_ONCE=true, redeploy, scrape the [V2 Gate] log lines, then
# unset the env var. Foregrounded (not backgrounded) because the gate is
# a quick read-only check and the operator wants the result in the boot
# log stream, not 5 minutes later.
echo "=== Optional: V2 reconciliation --gate (V2_RUN_GATE_ONCE) ==="
if [ "${V2_RUN_GATE_ONCE:-}" = "true" ]; then
  if [ -z "${V2_DATABASE_URL:-}" ]; then
    echo "[V2 Gate] SKIP: V2_DATABASE_URL is not set."
  else
    echo "[V2 Gate] Running reconciliation --gate (exit 1 on any divergence)..."
    if npx ts-node scripts/v1-vs-v2-reconcile.ts --gate 2>&1 | sed 's/^/[V2 Gate] /'; then
      gate_exit=${PIPESTATUS[0]:-1}
    else
      gate_exit=${PIPESTATUS[0]:-1}
    fi
    if [ "$gate_exit" = "0" ]; then
      echo "[V2 Gate] PASS — no divergence."
    else
      echo "[V2 Gate] FAIL — divergence detected (exit $gate_exit). Container continues; investigate via logs above."
    fi
  fi
else
  echo "[V2 Gate] V2_RUN_GATE_ONCE not 'true' — skipping."
fi

echo "=== Configuring fonts for share card rendering ==="
export FONTCONFIG_FILE=/app/assets/fonts.conf
mkdir -p /tmp/fontconfig-cache
fc-cache -f /app/assets 2>/dev/null || true

echo "=== Seeding billionaire data ==="
node scripts/seed-billionaires.js 2>&1 || echo "WARNING: Billionaire seed failed, continuing..."

echo "=== Starting server ==="
exec node dist/index.js
