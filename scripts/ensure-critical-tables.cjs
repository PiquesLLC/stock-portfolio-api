/**
 * Critical table / constraint repair — a FILE, deliberately.
 *
 * This logic used to live inside a double-quoted `node -e "..."` block in
 * scripts/start.sh. That is not a formatting preference; it was a defect with a
 * proven production consequence.
 *
 * Bash performs command substitution inside double quotes, and a comment in the
 * block referred to `prisma migrate deploy` in backticks. So on EVERY boot bash
 * ran prisma migrate deploy, spliced its multi-line stdout into the JavaScript
 * source, and Node died with SyntaxError before executing a single statement.
 * The surrounding `2>&1 || true` swallowed it. Net effect from 2026-05-27 to
 * 2026-08-26: this repair never ran, and an unintended second migrate deploy did.
 *
 * Note the backticks in the paragraph above. They are safe here and they are
 * meant to stay: a file argument is never shell-interpolated, so this file is a
 * live fixture for the regression test that proves it. Inlining this back into
 * start.sh would reintroduce the bug, and the startup-safety test would fail.
 *
 * BEHAVIOUR IS DELIBERATELY UNCHANGED. The DDL, the backfills, the message
 * strings and the fatal/non-fatal classification of each operation are exactly
 * what the block always intended to do:
 *
 *   - UserBlock / ValueRadarCache / RefreshRotationCache / PendingEmailChange
 *     DDL shares one try. A failure there skips the rest, as before.
 *   - CreatorWalletLedger idempotency backfill + index: non-fatal (warn).
 *   - CreatorPayout pending pre-clean + partial unique index: non-fatal (error).
 *
 * These are fallbacks for when prisma migrate deploy fails; the migrations
 * themselves remain the real source of truth. Making them newly fatal would add
 * risk with no evidence behind it, so their classification is preserved.
 *
 * EXIT STATUS is deterministic and means one thing only:
 *   0  the script ran to completion (individual non-fatal warnings may appear)
 *   1  the script could not run at all
 *
 * start.sh checks that status explicitly instead of `|| true`, so a script that
 * cannot run is loud rather than invisible. It still does not abort the boot:
 * that matches the block’s long-standing non-fatal-to-boot classification, and
 * the hard startup invariant lives in db-repair-verify.cjs.
 */

const { createClient } = require('@libsql/client');

const client = createClient({ url: process.env.DATABASE_URL || 'file:/data/nala.db' });

async function ensureCriticalTables() {
    try {
      await client.execute('CREATE TABLE IF NOT EXISTS "UserBlock" ("id" TEXT NOT NULL PRIMARY KEY, "blockerId" TEXT NOT NULL, "blockedId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "UserBlock_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT "UserBlock_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)');
      await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS "UserBlock_blockerId_blockedId_key" ON "UserBlock"("blockerId", "blockedId")');
      await client.execute('CREATE TABLE IF NOT EXISTS "ValueRadarCache" ("id" TEXT NOT NULL PRIMARY KEY, "ticker" TEXT NOT NULL, "avgPE" REAL, "peHistoryJson" TEXT, "yearsOfData" INTEGER, "lastFetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
      await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS "ValueRadarCache_ticker_key" ON "ValueRadarCache"("ticker")');
      await client.execute('CREATE TABLE IF NOT EXISTS "RefreshRotationCache" ("id" TEXT NOT NULL PRIMARY KEY, "oldTokenHash" TEXT NOT NULL, "newTokenCipher" TEXT NOT NULL, "payloadJson" TEXT NOT NULL, "userId" TEXT NOT NULL, "family" TEXT NOT NULL, "consumed" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "RefreshRotationCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)');
      await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS "RefreshRotationCache_oldTokenHash_key" ON "RefreshRotationCache"("oldTokenHash")');
      await client.execute('CREATE INDEX IF NOT EXISTS "RefreshRotationCache_userId_idx" ON "RefreshRotationCache"("userId")');
      await client.execute('CREATE INDEX IF NOT EXISTS "RefreshRotationCache_createdAt_idx" ON "RefreshRotationCache"("createdAt")');
      await client.execute('CREATE TABLE IF NOT EXISTS "PendingEmailChange" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "newEmail" TEXT NOT NULL, "codeHash" TEXT NOT NULL, "expiresAt" DATETIME NOT NULL, "usedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "PendingEmailChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)');
      await client.execute('CREATE INDEX IF NOT EXISTS "PendingEmailChange_userId_idx" ON "PendingEmailChange"("userId")');
      await client.execute('CREATE INDEX IF NOT EXISTS "PendingEmailChange_expiresAt_idx" ON "PendingEmailChange"("expiresAt")');
      // CreatorWalletLedger DB-level idempotency (migration 20260527_add_ledger_idempotency).
      // Runs the same backfills + UNIQUE INDEX as the migration in case
      // `prisma migrate deploy` fails for any reason. Subsequent boots are no-ops:
      // the UPDATEs only match rows still in the legacy shape, and the index
      // uses IF NOT EXISTS.
      try {
        await client.execute("UPDATE \"CreatorWalletLedger\" SET description = 'payout:' || rowid WHERE type = 'payout' AND description = 'Payout requested'");
        await client.execute("UPDATE \"CreatorWalletLedger\" SET description = description || ':' || rowid WHERE description IN ('admin_fix:initial_payment', 'admin_fix:platform_fee')");
        await client.execute("UPDATE \"CreatorWalletLedger\" SET description = description || ':dup:' || rowid WHERE id IN (SELECT l1.id FROM \"CreatorWalletLedger\" l1 JOIN \"CreatorWalletLedger\" l2 ON l1.\"creatorUserId\" = l2.\"creatorUserId\" AND l1.description = l2.description AND l1.description IS NOT NULL AND l1.rowid > l2.rowid)");
        await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS "creator_wallet_ledger_creator_desc_unique" ON "CreatorWalletLedger"("creatorUserId", "description")');
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
        const dupResult = await client.execute("UPDATE \"CreatorPayout\" SET status = 'failed' WHERE status = 'pending' AND rowid NOT IN (SELECT MIN(rowid) FROM \"CreatorPayout\" WHERE status = 'pending' GROUP BY \"creatorUserId\")");
        if (dupResult.rowsAffected > 0) {
          console.error('[Startup] WARNING: marked ' + dupResult.rowsAffected + ' duplicate pending CreatorPayout rows as failed to allow unique-index creation. Manual ledger reconciliation may be required.');
        }
        await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS "creator_payout_pending_unique" ON "CreatorPayout"("creatorUserId") WHERE "status" = \'pending\'');
      } catch (e) {
        // Elevated to error (was warn) so this is visible in any log aggregator.
        // The constraint is critical for payout safety — losing it silently is
        // worse than crashing the boot.
        console.error('[Startup] CRITICAL: Payout pending unique-index setup failed:', e.message);
      }
      console.log('[Startup] Critical tables ensured');
    } catch (e) { console.warn('[Startup] Table ensure failed:', e.message); }
}

async function closeClient() {
  try {
    await client.close();
  } catch (err) {
    console.warn('[EnsureTables] client close failed:', err.message);
  }
}

ensureCriticalTables()
  .then(async () => {
    await closeClient();
    console.log('[EnsureTables] complete');
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[EnsureTables] CRITICAL: did not complete:', err && err.message ? err.message : err);
    await closeClient();
    process.exit(1);
  });
