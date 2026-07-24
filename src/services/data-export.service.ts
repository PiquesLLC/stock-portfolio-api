import prisma from '../utils/prisma';

// GDPR Article 15/20 — a complete, machine-readable export of everything Nala
// holds about a user. Secrets are excluded BY CONSTRUCTION: no password hash,
// refresh/session tokens, MFA secrets or backup codes, email OTPs, or Plaid
// access tokens — only the user's own data. Tables with secret columns use an
// explicit allow-list select (verified against prisma/schema.prisma); benign
// tables use the default scalar select.

const USER_SAFE_SELECT = {
  id: true, username: true, displayName: true, plan: true, planStartedAt: true,
  planExpiresAt: true, createdAt: true, trackingActive: true, trackingStartAt: true,
  leaderboardEligible: true, leaderboardEligibleAt: true, profilePublic: true,
  region: true, showRegion: true, timezone: true, holdingsVisibility: true,
  bio: true, email: true, emailVerified: true, avatarUrl: true,
} as const;

// MfaMethod without secretCiphertext; PlaidItem without accessTokenEnc.
const MFA_SAFE_SELECT = { type: true, enabled: true, verifiedAt: true, createdAt: true } as const;
const PLAID_SAFE_SELECT = {
  id: true, plaidItemId: true, institutionId: true, institutionName: true,
  consentExpiresAt: true, status: true, createdAt: true, updatedAt: true,
} as const;
// CreatorSubscription WITHOUT stripeSubscriptionId — the OR-scope can return a
// creator's subscribers' rows, and a Stripe billing id is not part of the
// relationship (and is the same class this export excludes on User).
const CREATOR_SUB_SAFE_SELECT = {
  id: true, subscriberUserId: true, creatorUserId: true, status: true,
  currentPeriodEnd: true, trialEnd: true, disputedAt: true, canceledAt: true,
  createdAt: true, updatedAt: true,
} as const;

// Cap the snapshot export so a user with a very large history can't force a
// multi-MB in-memory serialization. Retention keeps per-user counts well under
// this; the cap is a memory-safety backstop, not an expected truncation.
const MAX_EXPORT_SNAPSHOTS = 50000;

// Run a query defensively: a model that doesn't exist in this environment (the
// delete path uses the same optional-chaining guard) or a transient error yields
// null rather than failing the whole export.
async function safeQ<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return (await fn()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Assemble the full data export for a user. Returns null if the user does not exist.
 */
export async function exportUserData(userId: string): Promise<Record<string, unknown> | null> {
  const profile = await prisma.user.findUnique({ where: { id: userId }, select: USER_SAFE_SELECT });
  if (!profile) return null;

  const [
    settings, consentRecords, portfolios, holdings, lots, trades, ledgerEvents, transactions,
    dividendCredits, dividendReinvestments, dismissedDividends, goals, watchlists,
    alerts, priceAlerts, milestoneEvents, anomalyEvents, portfolioSnapshots,
    following, followers, stockFollows, posts, comments, likes, deepResearchJobs,
    plaidItems, creatorSubscriptions, creatorWalletLedger, analyticsEvents, apiUsageLogs, mfaMethods,
  ] = await Promise.all([
    safeQ(() => prisma.userSettings.findUnique({ where: { userId } })),
    safeQ(() => prisma.consentRecord.findMany({ where: { userId } })),
    safeQ(() => prisma.portfolio.findMany({ where: { userId } })),
    safeQ(() => prisma.holding.findMany({ where: { userId } })),
    safeQ(() => prisma.lot.findMany({ where: { userId } })),
    safeQ(() => prisma.portfolioTrade.findMany({ where: { userId } })),
    safeQ(() => prisma.ledgerEvent.findMany({ where: { userId } })),
    safeQ(() => prisma.transaction.findMany({ where: { userId } })),
    safeQ(() => prisma.dividendCredit.findMany({ where: { userId } })),
    safeQ(() => prisma.dividendReinvestment.findMany({ where: { userId } })),
    safeQ(() => prisma.dismissedDividend.findMany({ where: { userId } })),
    safeQ(() => prisma.goal.findMany({ where: { userId } })),
    safeQ(() => prisma.watchlist.findMany({ where: { userId } })),
    safeQ(() => prisma.alert.findMany({ where: { userId } })),
    safeQ(() => prisma.priceAlert.findMany({ where: { userId } })),
    safeQ(() => prisma.milestoneEvent.findMany({ where: { userId } })),
    safeQ(() => prisma.anomalyEvent.findMany({ where: { userId } })),
    safeQ(() => prisma.portfolioSnapshot.findMany({ where: { userId }, orderBy: { timestamp: 'desc' }, take: MAX_EXPORT_SNAPSHOTS })),
    safeQ(() => prisma.follow.findMany({ where: { followerId: userId } })),
    safeQ(() => prisma.follow.findMany({ where: { followingId: userId } })),
    safeQ(() => prisma.stockFollow.findMany({ where: { userId } })),
    safeQ(() => prisma.post.findMany({ where: { userId } })),
    safeQ(() => prisma.comment.findMany({ where: { userId } })),
    safeQ(() => prisma.like.findMany({ where: { userId } })),
    safeQ(() => prisma.deepResearchJob.findMany({ where: { userId } })),
    safeQ(() => prisma.plaidItem.findMany({ where: { userId }, select: PLAID_SAFE_SELECT })),
    safeQ(() => prisma.creatorSubscription.findMany({ where: { OR: [{ subscriberUserId: userId }, { creatorUserId: userId }] }, select: CREATOR_SUB_SAFE_SELECT })),
    safeQ(() => prisma.creatorWalletLedger.findMany({ where: { creatorUserId: userId } })),
    safeQ(() => prisma.analyticsEvent.findMany({ where: { userId } })),
    safeQ(() => prisma.apiUsageLog.findMany({ where: { userId } })),
    safeQ(() => prisma.mfaMethod.findMany({ where: { userId }, select: MFA_SAFE_SELECT })),
  ]);

  return {
    profile,
    consentRecords,
    settings,
    portfolios,
    holdings,
    lots,
    trades,
    ledgerEvents,
    transactions,
    dividendCredits,
    dividendReinvestments,
    dismissedDividends,
    goals,
    watchlists,
    alerts,
    priceAlerts,
    milestoneEvents,
    anomalyEvents,
    portfolioSnapshots,
    social: { following, followers, stockFollows, posts, comments, likes },
    deepResearchJobs,
    plaidItems, // metadata only — access tokens excluded
    creatorSubscriptions,
    creatorWalletLedger,
    analyticsEvents,
    apiUsageLogs,
    security: { mfaMethods }, // MFA type/status only — no secrets or backup codes
  };
}
