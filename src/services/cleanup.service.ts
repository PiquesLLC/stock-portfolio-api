import prisma from '../utils/prisma';

/**
 * Daily cleanup of stale data to prevent database bloat.
 * Keeps the SQLite database lean and avoids SQLITE_FULL errors.
 */
export async function cleanupStaleData(): Promise<void> {
  const now = new Date();
  let totalDeleted = 0;

  try {
    // 1. Portfolio snapshots older than 90 days
    const snapshotCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const snapshots = await prisma.portfolioSnapshot.deleteMany({
      where: { timestamp: { lt: snapshotCutoff } },
    });
    totalDeleted += snapshots.count;

    // 2. Analytics events older than 30 days
    const analyticsCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const analytics = await prisma.analyticsEvent.deleteMany({
      where: { createdAt: { lt: analyticsCutoff } },
    }).catch(() => ({ count: 0 })); // Table may not exist
    totalDeleted += analytics.count;

    // 3. API usage logs older than 30 days
    const apiLogCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const apiLogs = await prisma.apiUsageLog.deleteMany({
      where: { createdAt: { lt: apiLogCutoff } },
    }).catch(() => ({ count: 0 }));
    totalDeleted += apiLogs.count;

    // 4. Job run records older than 7 days
    const jobCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const jobs = await prisma.backgroundJobRun.deleteMany({
      where: { startedAt: { lt: jobCutoff } },
    }).catch(() => ({ count: 0 }));
    totalDeleted += jobs.count;

    // 5. Notification audit logs older than 30 days
    const auditCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const audits = await prisma.notificationAuditLog.deleteMany({
      where: { sentAt: { lt: auditCutoff } },
    }).catch(() => ({ count: 0 }));
    totalDeleted += audits.count;

    // 6. Read social notifications older than 30 days
    const socialCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const social = await prisma.socialNotification.deleteMany({
      where: { read: true, createdAt: { lt: socialCutoff } },
    }).catch(() => ({ count: 0 }));
    totalDeleted += social.count;

    // 7. Dead letter entries older than 14 days
    const deadLetterCutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const deadLetters = await prisma.deadLetterEntry.deleteMany({
      where: { createdAt: { lt: deadLetterCutoff } },
    }).catch(() => ({ count: 0 }));
    totalDeleted += deadLetters.count;

    // 8. Expired or revoked refresh tokens
    const expiredTokens = await prisma.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }] },
    }).catch(() => ({ count: 0 }));
    totalDeleted += expiredTokens.count;

    // 9. Holding snapshots older than 90 days — parity with PortfolioSnapshot (step 1).
    // This table is the dominant disk-growth driver (one row per holding every
    // snapshot cycle) and previously had NO scheduled retention, so it grew
    // unbounded — the slow-fill behind the 91%-full volume. Chunked deletes keep
    // the WAL bounded on a tight SQLite volume (mirrors the admin /cleanup-db
    // endpoint). NOTE: returning freed pages to the OS still needs VACUUM (run
    // with disk headroom) — the incremental_vacuum below reclaims gradually when
    // the DB's auto_vacuum is INCREMENTAL; it is a harmless no-op otherwise.
    let holdingSnaps = 0;
    try {
      for (let chunk = 0; chunk < 500; chunk++) {
        const deleted = await prisma.$executeRawUnsafe(
          `DELETE FROM "HoldingSnapshot" WHERE rowid IN (SELECT rowid FROM "HoldingSnapshot" WHERE "timestamp" < datetime('now', '-90 days') LIMIT 5000)`
        );
        holdingSnaps += deleted;
        if (deleted < 5000) break;
      }
    } catch (err) {
      console.error('[Cleanup] HoldingSnapshot prune failed:', (err as Error).message);
    }
    totalDeleted += holdingSnaps;

    await prisma.$executeRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
    await prisma.$executeRawUnsafe('PRAGMA incremental_vacuum').catch(() => {});

    console.log(`[Cleanup] Removed ${totalDeleted} stale records (snapshots: ${snapshots.count}, holdingSnaps: ${holdingSnaps}, analytics: ${analytics.count}, apiLogs: ${apiLogs.count}, jobs: ${jobs.count}, audits: ${audits.count}, social: ${social.count}, deadLetters: ${deadLetters.count}, expiredTokens: ${expiredTokens.count})`);
  } catch (err) {
    console.error('[Cleanup] Failed:', (err as Error).message);
  }
}
