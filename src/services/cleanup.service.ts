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

    console.log(`[Cleanup] Removed ${totalDeleted} stale records (snapshots: ${snapshots.count}, analytics: ${analytics.count}, apiLogs: ${apiLogs.count}, jobs: ${jobs.count}, audits: ${audits.count}, social: ${social.count})`);
  } catch (err) {
    console.error('[Cleanup] Failed:', (err as Error).message);
  }
}
