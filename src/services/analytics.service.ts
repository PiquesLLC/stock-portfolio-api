import prisma from '../utils/prisma';

export interface AnalyticsEventInput {
  sessionId: string;
  event: string;
  feature: string;
  subFeature?: string | null;
  metadata?: string | null;
  durationMs?: number | null;
}

interface FeatureUsageRow {
  feature: string;
  views: number;
  uniqueUsers: number;
  totalTimeMs: number;
  avgTimeMs: number;
  pctOfTotal: number;
}

interface DauTrendRow {
  date: string;
  count: number;
}

interface OverviewStats {
  totalEvents: number;
  uniqueUsers: number;
  totalSessions: number;
  avgSessionDurationMs: number;
}

interface UserEngagementStats {
  registeredUsers: number;
  activeUsers: number;
  portfoliosCreated: number;
  holdingsCount: number;
  watchlistsCount: number;
}

export interface DashboardData {
  overview: OverviewStats;
  featureUsage: FeatureUsageRow[];
  userEngagement: UserEngagementStats;
  dauTrend: DauTrendRow[];
}

function periodToDays(period: string): number {
  switch (period) {
    case '30d': return 30;
    case '90d': return 90;
    case '7d':
    default: return 7;
  }
}

/**
 * Bulk insert analytics events for a user.
 */
export async function createEvents(
  userId: string,
  events: AnalyticsEventInput[]
): Promise<number> {
  const data = events.map((e) => ({
    userId,
    sessionId: e.sessionId,
    event: e.event,
    feature: e.feature,
    subFeature: e.subFeature ?? null,
    metadata: e.metadata ?? null,
    durationMs: e.durationMs ?? null,
  }));

  const result = await prisma.analyticsEvent.createMany({ data });
  return result.count;
}

/**
 * Get dashboard analytics overview for admin.
 */
export async function getDashboard(period: string = '7d'): Promise<DashboardData> {
  const days = periodToDays(period);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Overview stats
  const overviewRows = await prisma.$queryRawUnsafe<
    { totalEvents: number; uniqueUsers: number; uniqueSessions: number }[]
  >(
    `SELECT
       COUNT(*) as totalEvents,
       COUNT(DISTINCT userId) as uniqueUsers,
       COUNT(DISTINCT sessionId) as uniqueSessions
     FROM AnalyticsEvent
     WHERE createdAt >= ?`,
    since
  );

  const overview = {
    totalEvents: Number(overviewRows[0]?.totalEvents ?? 0),
    uniqueUsers: Number(overviewRows[0]?.uniqueUsers ?? 0),
    totalSessions: Number(overviewRows[0]?.uniqueSessions ?? 0),
    avgSessionDurationMs: 0,
  };

  // Average session duration (sum durationMs per session, then average)
  const avgSessionRows = await prisma.$queryRawUnsafe<
    { avgDuration: number }[]
  >(
    `SELECT AVG(sessionTotal) as avgDuration FROM (
       SELECT sessionId, SUM(durationMs) as sessionTotal
       FROM AnalyticsEvent
       WHERE createdAt >= ? AND durationMs IS NOT NULL
       GROUP BY sessionId
     )`,
    since
  );
  overview.avgSessionDurationMs = Math.round(Number(avgSessionRows[0]?.avgDuration ?? 0));

  // Feature usage breakdown
  const featureRows = await prisma.$queryRawUnsafe<
    { feature: string; views: number; uniqueUsers: number; totalDurationMs: number; avgDurationMs: number }[]
  >(
    `SELECT
       feature,
       COUNT(*) as views,
       COUNT(DISTINCT userId) as uniqueUsers,
       COALESCE(SUM(durationMs), 0) as totalDurationMs,
       COALESCE(AVG(durationMs), 0) as avgDurationMs
     FROM AnalyticsEvent
     WHERE createdAt >= ?
     GROUP BY feature
     ORDER BY views DESC`,
    since
  );

  const totalViews = featureRows.reduce((sum, r) => sum + Number(r.views), 0);
  const featureUsage: FeatureUsageRow[] = featureRows.map((r) => ({
    feature: r.feature,
    views: Number(r.views),
    uniqueUsers: Number(r.uniqueUsers),
    totalTimeMs: Number(r.totalDurationMs),
    avgTimeMs: Math.round(Number(r.avgDurationMs)),
    pctOfTotal: totalViews > 0 ? Math.round((Number(r.views) / totalViews) * 10000) / 100 : 0,
  }));

  // User engagement stats (from main app tables)
  const [registeredUsers, activeUsers, portfoliosCreated, totalHoldings, watchlists] = await Promise.all([
    prisma.user.count(),
    prisma.$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(DISTINCT userId) as count FROM AnalyticsEvent WHERE createdAt >= ?`,
      since
    ),
    prisma.portfolio.count(),
    prisma.holding.count(),
    prisma.watchlist.count(),
  ]);

  const userEngagement: UserEngagementStats = {
    registeredUsers,
    activeUsers: Number(activeUsers[0]?.count ?? 0),
    portfoliosCreated,
    holdingsCount: totalHoldings,
    watchlistsCount: watchlists,
  };

  // DAU trend — daily active unique users
  const dauRows = await prisma.$queryRawUnsafe<
    { date: string; count: number }[]
  >(
    `SELECT
       DATE(createdAt) as date,
       COUNT(DISTINCT userId) as count
     FROM AnalyticsEvent
     WHERE createdAt >= ?
     GROUP BY DATE(createdAt)
     ORDER BY date ASC`,
    since
  );

  const dauTrend: DauTrendRow[] = dauRows.map((r) => ({
    date: r.date,
    count: Number(r.count),
  }));

  return { overview, featureUsage, userEngagement, dauTrend };
}

/**
 * Delete analytics events older than 90 days for data retention compliance.
 */
export async function cleanupOldEvents(): Promise<number> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const deleted = await prisma.analyticsEvent.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return deleted.count;
}
