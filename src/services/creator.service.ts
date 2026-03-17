import prisma from '../utils/prisma';
import { checkAndUpdateStripeConnectStatus } from './creator-billing.service';

export type CreatorAccessLevel = 'public' | 'follower' | 'paid';
export type CreatorSection =
  | 'holdings'
  | 'tradeHistory'
  | 'rationale'
  | 'sectors'
  | 'riskMetrics'
  | 'watchlists';
export type CreatorCtaState = {
  requiresAuth: boolean;
  canSubscribe: boolean;
  priceCents: number | null;
  subscriberCount: number;
  unlocks: CreatorSection[];
  disclaimer: string;
};
export type CreatorEntitlement = {
  level: CreatorAccessLevel;
  accessibleSections: CreatorSection[];
  cta: CreatorCtaState;
};

const MIN_PRICING_CENTS = 100; // $1.00 minimum
const MAX_PRICING_CENTS = 99999; // $999.99 maximum
// SEC copy-trading guidelines: 0 delay is not allowed — minimum 24hr
const VALID_TRADE_DELAY_HOURS = new Set([24, 48, 72]);
const DISCLAIMER = 'Educational content only. Not investment advice.';

export async function applyAsCreator(userId: string, pitch?: string): Promise<{
  status: string;
  creatorId: string;
}> {
  const existing = await prisma.creator.findUnique({
    where: { userId },
    select: { id: true, status: true },
  });
  if (existing) {
    return { status: existing.status, creatorId: existing.id };
  }

  const created = await prisma.creator.create({
    data: {
      userId,
      status: 'pending',
      pitch: pitch?.trim() || null,
      complianceAcceptedAt: new Date(),
      visibility: {
        create: {
          showHoldings: true,
          showTradeHistory: false,
          showRationale: false,
          showSectors: true,
          showRiskMetrics: false,
          showWatchlists: false,
          tradeDelayHours: 24,
          hideShareCount: false,
        },
      },
    },
    select: { id: true, status: true },
  });

  return { status: created.status, creatorId: created.id };
}

export async function activateCreator(userId: string): Promise<void> {
  await prisma.creator.update({
    where: { userId },
    data: { status: 'active' },
  });
}

export async function resolveAccessLevel(creatorUserId: string, viewerId?: string): Promise<CreatorAccessLevel> {
  if (!viewerId) return 'public';
  if (viewerId === creatorUserId) return 'paid';
  const now = new Date();

  const [subscription, follow] = await Promise.all([
    prisma.creatorSubscription.findFirst({
      where: {
        creatorUserId,
        subscriberUserId: viewerId,
        status: { in: ['active', 'canceled', 'trialing', 'past_due'] },
        OR: [
          { trialEnd: { gt: now } },
          // Null period end: grace period for just-created subscriptions (24h max)
          { currentPeriodEnd: null, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
          { currentPeriodEnd: { gt: now } },
        ],
      },
      select: { id: true, currentPeriodEnd: true, trialEnd: true },
    }),
    prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerId, followingId: creatorUserId } },
      select: { id: true },
    }),
  ]);

  if (subscription) return 'paid';
  if (follow) return 'follower';
  return 'public';
}

export async function getEntitlement(creatorUserId: string, viewerId?: string): Promise<{
  level: CreatorAccessLevel;
  accessibleSections: CreatorSection[];
  cta: CreatorCtaState;
}> {
  const creator = await prisma.creator.findUnique({
    where: { userId: creatorUserId },
    include: { visibility: true },
  });
  if (!creator || creator.status !== 'active' || !creator.visibility) {
    return {
      level: 'public',
      accessibleSections: [],
      cta: {
        requiresAuth: !viewerId,
        canSubscribe: false,
        priceCents: null,
        subscriberCount: 0,
        unlocks: [],
        disclaimer: DISCLAIMER,
      },
    };
  }

  const level = await resolveAccessLevel(creatorUserId, viewerId);
  const sections: CreatorSection[] = [];
  if (creator.visibility.showHoldings) sections.push('holdings');
  if (creator.visibility.showTradeHistory) sections.push('tradeHistory');
  if (creator.visibility.showRationale) sections.push('rationale');
  if (creator.visibility.showSectors) sections.push('sectors');
  if (creator.visibility.showRiskMetrics) sections.push('riskMetrics');
  if (creator.visibility.showWatchlists) sections.push('watchlists');
  const subscriberCount = await prisma.creatorSubscription.count({
    where: { creatorUserId, status: 'active' },
  });
  return {
    level,
    accessibleSections: level === 'paid' ? sections : [],
    cta: {
      requiresAuth: !viewerId,
      canSubscribe: level !== 'paid',
      priceCents: creator.pricingCents,
      subscriberCount,
      unlocks: sections,
      disclaimer: DISCLAIMER,
    },
  };
}

export async function getCreatorProfile(creatorUserId: string, viewerId?: string): Promise<{
  userId: string;
  creatorUserId: string;
  username: string;
  displayName: string;
  status: string;
  pricingCents: number;
  trialDays: 0;
  pitch: string | null;
  stripeConnectOnboarded: boolean;
  complianceAcceptedAt: string | null;
  createdAt: string;
  visibility: {
    showHoldings: boolean;
    showTradeHistory: boolean;
    showRationale: boolean;
    showSectors: boolean;
    showRiskMetrics: boolean;
    showWatchlists: boolean;
    tradeDelayHours: number;
    hideShareCount: boolean;
  } | null;
  accessLevel: CreatorAccessLevel;
  entitlement: CreatorSection[];
  cta: CreatorCtaState;
  subscriberCount: number;
  disclaimer: string;
} | null> {
  const creator = await prisma.creator.findUnique({
    where: { userId: creatorUserId },
    include: { visibility: true },
  });
  if (!creator) return null;
  // Hide non-active profiles from external viewers; let creators see their own
  if (creator.status !== 'active' && viewerId !== creatorUserId) return null;

  // Fallback: if not yet marked onboarded but has a stripeConnectId, check Stripe directly
  // Only do this for self-view to avoid unnecessary Stripe API calls for external viewers
  let stripeConnectOnboarded = creator.stripeConnectOnboarded;
  if (!stripeConnectOnboarded && creator.stripeConnectId && viewerId === creatorUserId) {
    stripeConnectOnboarded = await checkAndUpdateStripeConnectStatus(creatorUserId);
  }

  const [entitlement, subscriberCount] = await Promise.all([
    getEntitlement(creatorUserId, viewerId),
    prisma.creatorSubscription.count({
      where: { creatorUserId, status: 'active' },
    }),
  ]);

  // Fetch display info for the creator user
  const user = await prisma.user.findUnique({
    where: { id: creatorUserId },
    select: { username: true, displayName: true },
  });

  return {
    userId: creatorUserId,
    creatorUserId,
    username: user?.username ?? '',
    displayName: user?.displayName ?? '',
    status: creator.status,
    pricingCents: creator.pricingCents,
    trialDays: 0,
    pitch: creator.pitch,
    stripeConnectOnboarded,
    complianceAcceptedAt: creator.complianceAcceptedAt?.toISOString() ?? null,
    createdAt: creator.createdAt.toISOString(),
    visibility: creator.visibility ? {
      showHoldings: creator.visibility.showHoldings,
      showTradeHistory: creator.visibility.showTradeHistory,
      showRationale: creator.visibility.showRationale,
      showSectors: creator.visibility.showSectors,
      showRiskMetrics: creator.visibility.showRiskMetrics,
      showWatchlists: creator.visibility.showWatchlists,
      tradeDelayHours: creator.visibility.tradeDelayHours,
      hideShareCount: creator.visibility.hideShareCount,
    } : null,
    accessLevel: entitlement.level,
    entitlement: entitlement.accessibleSections,
    cta: entitlement.cta,
    subscriberCount: entitlement.cta.subscriberCount || subscriberCount,
    disclaimer: DISCLAIMER,
  };
}

type CreatorSettingsInput = {
  pricingCents?: number;
  pitch?: string | null;
  showHoldings?: boolean;
  showTradeHistory?: boolean;
  showRationale?: boolean;
  showSectors?: boolean;
  showRiskMetrics?: boolean;
  showWatchlists?: boolean;
  tradeDelayHours?: number;
  hideShareCount?: boolean;
  discoverable?: boolean;
};

export async function updateCreatorSettings(userId: string, settings: CreatorSettingsInput): Promise<void> {
  if (settings.pricingCents !== undefined && (settings.pricingCents < MIN_PRICING_CENTS || settings.pricingCents > MAX_PRICING_CENTS)) {
    throw new Error('Price must be between $1.00 and $999.99');
  }
  if (settings.tradeDelayHours !== undefined && !VALID_TRADE_DELAY_HOURS.has(settings.tradeDelayHours)) {
    throw new Error('Invalid trade delay');
  }

  const creator = await prisma.creator.findUnique({
    where: { userId },
    select: { id: true, status: true },
  });
  if (!creator) {
    throw new Error('Creator not found');
  }
  if (creator.status === 'suspended') {
    throw new Error('Account suspended');
  }

  await prisma.$transaction([
    prisma.creator.update({
      where: { userId },
      data: {
        pricingCents: settings.pricingCents,
        trialDays: 0,
        pitch: settings.pitch === undefined ? undefined : (settings.pitch?.trim() || null),
      },
    }),
    prisma.creatorVisibility.update({
      where: { creatorId: creator.id },
      data: {
        showHoldings: settings.showHoldings,
        showTradeHistory: settings.showTradeHistory,
        showRationale: settings.showRationale,
        showSectors: settings.showSectors,
        showRiskMetrics: settings.showRiskMetrics,
        showWatchlists: settings.showWatchlists,
        tradeDelayHours: settings.tradeDelayHours,
        hideShareCount: settings.hideShareCount,
        discoverable: settings.discoverable,
      },
    }),
  ]);
}

export async function getLockedContent(
  creatorUserId: string,
  viewerId: string,
  section: CreatorSection
): Promise<unknown> {
  const [entitlement, creator] = await Promise.all([
    getEntitlement(creatorUserId, viewerId),
    prisma.creator.findUnique({
      where: { userId: creatorUserId },
      include: { visibility: true },
    }),
  ]);

  if (!creator?.visibility) {
    throw new Error('Creator not found');
  }
  if (!entitlement.accessibleSections.includes(section)) {
    const err = new Error('Forbidden');
    (err as Error & { code?: string }).code = 'FORBIDDEN';
    throw err;
  }

  const tradeDelayCutoff = new Date(Date.now() - creator.visibility.tradeDelayHours * 60 * 60 * 1000);
  const hideShareCount = creator.visibility.hideShareCount && entitlement.level !== 'paid';

  switch (section) {
    case 'holdings': {
      const holdings = await prisma.holding.findMany({
        where: { userId: creatorUserId },
        orderBy: { ticker: 'asc' },
      });

      // Apply trade delay: hide holdings added within the delay window
      // and revert holdings that were updated within the delay window.
      // This mirrors the reverse-apply logic in getUserPortfolioHandler.
      if (creator.visibility.tradeDelayHours > 0 && viewerId !== creatorUserId) {
        const recentEvents = await prisma.activityEvent.findMany({
          where: { userId: creatorUserId, createdAt: { gt: tradeDelayCutoff } },
          orderBy: { createdAt: 'asc' },
        });

        if (recentEvents.length > 0) {
          const addedTickers = new Set<string>();
          const revertedState = new Map<string, { shares: number; averageCost: number }>();
          const removedHoldings: { ticker: string; shares: number; averageCost: number; createdAt: Date }[] = [];

          for (const evt of recentEvents) {
            let payload: { ticker?: string; shares?: number; previousShares?: number; averageCost?: number; previousAverageCost?: number };
            try { payload = JSON.parse(evt.payload); } catch { continue; }
            const t = payload.ticker?.toUpperCase();
            if (!t) continue;

            if (evt.type === 'holding_added') {
              addedTickers.add(t);
            } else if (evt.type === 'holding_updated') {
              if (payload.previousShares != null && !revertedState.has(t)) {
                const h = holdings.find(h2 => h2.ticker.toUpperCase() === t);
                revertedState.set(t, {
                  shares: payload.previousShares,
                  averageCost: payload.previousAverageCost ?? (h?.averageCost ?? payload.averageCost ?? 0),
                });
              }
            } else if (evt.type === 'holding_removed') {
              if (payload.shares != null && payload.averageCost != null) {
                const reverted = revertedState.get(t);
                removedHoldings.push(reverted
                  ? { ticker: t, shares: reverted.shares, averageCost: reverted.averageCost, createdAt: new Date(0) }
                  : { ticker: t, shares: payload.shares, averageCost: payload.averageCost, createdAt: new Date(0) }
                );
              }
            }
          }

          // Build the delayed view of holdings
          let delayedHoldings = holdings
            .filter(h => !addedTickers.has(h.ticker.toUpperCase()))
            .map(h => {
              const reverted = revertedState.get(h.ticker.toUpperCase());
              if (reverted) {
                return { ...h, shares: reverted.shares, averageCost: reverted.averageCost };
              }
              return h;
            });

          // Re-add holdings that were removed within the delay window
          for (const removed of removedHoldings) {
            if (!addedTickers.has(removed.ticker)) {
              delayedHoldings.push({
                ticker: removed.ticker,
                shares: removed.shares,
                averageCost: removed.averageCost,
                createdAt: removed.createdAt,
              } as typeof holdings[number]);
            }
          }

          return delayedHoldings.map((h) => ({
            ticker: h.ticker,
            shares: hideShareCount ? 0 : h.shares,
            averageCost: hideShareCount ? 0 : h.averageCost,
            createdAt: h.createdAt,
          }));
        }
      }

      return holdings.map((h) => ({
        ticker: h.ticker,
        shares: hideShareCount ? 0 : h.shares,
        averageCost: hideShareCount ? 0 : h.averageCost,
        createdAt: h.createdAt,
      }));
    }
    case 'tradeHistory': {
      const trades = await prisma.portfolioTrade.findMany({
        where: {
          userId: creatorUserId,
          date: { lte: tradeDelayCutoff },
        },
        orderBy: { date: 'desc' },
        take: 200,
        select: {
          ticker: true,
          type: true,
          date: true,
          shares: hideShareCount ? false : true,
          price: true,
        },
      });
      return trades;
    }
    case 'watchlists': {
      const watchlists = await prisma.watchlist.findMany({
        where: { userId: creatorUserId },
        include: { holdings: true },
      });
      return watchlists.map((w) => ({
        id: w.id,
        name: w.name,
        holdings: w.holdings.map((h) => ({
          ticker: h.ticker,
          shares: hideShareCount ? 0 : h.shares,
          averageCost: hideShareCount ? 0 : h.averageCost,
        })),
      }));
    }
    case 'sectors': {
      return { message: 'Sector analytics unlocked for subscribers.' };
    }
    case 'riskMetrics': {
      return { message: 'Risk metrics unlocked for subscribers.' };
    }
    case 'rationale': {
      return { message: 'Creator rationale unlocked for subscribers.' };
    }
    default: {
      return null;
    }
  }
}

export async function getPayoutBalanceFromLedger(userId: string): Promise<number> {
  const entries = await prisma.creatorWalletLedger.findMany({
    where: { creatorUserId: userId },
    select: { type: true, amountCents: true },
  });

  let balance = 0;
  for (const entry of entries) {
    if (entry.type === 'earning') balance += Math.abs(entry.amountCents);
    if (entry.type === 'payout' || entry.type === 'refund') balance -= Math.abs(entry.amountCents);
  }
  return Math.max(0, balance);
}

export async function getCreatorDashboard(userId: string): Promise<{
  mrr: number;
  activeSubscribers: number;
  churnRatePct: number;
  totalEarningsCents: number;
  payoutBalanceCents: number;
  monthlyEarnings: Array<{ month: string; amountCents: number }>;
  recentEvents: Array<{ type: string; description: string; createdAt: Date }>;
}> {
  const creator = await prisma.creator.findUnique({
    where: { userId },
    select: { pricingCents: true, id: true, status: true },
  });
  if (!creator || creator.status !== 'active') {
    return { mrr: 0, activeSubscribers: 0, churnRatePct: 0, totalEarningsCents: 0, payoutBalanceCents: 0, monthlyEarnings: [], recentEvents: [] };
  }

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [activeSubscribers, churnedLast30, ledger, recentEvents, rawPayoutBalance, pendingPayoutAgg] = await Promise.all([
    prisma.creatorSubscription.count({
      where: { creatorUserId: userId, status: 'active' },
    }),
    prisma.creatorSubscription.count({
      where: {
        creatorUserId: userId,
        status: { in: ['canceled', 'expired'] },
        updatedAt: { gte: thirtyDaysAgo },
      },
    }),
    prisma.creatorWalletLedger.findMany({
      where: { creatorUserId: userId, type: 'earning' },
      select: { amountCents: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.creatorSubscriptionEvent.findMany({
      where: { subscription: { creatorUserId: userId } },
      include: { subscription: { select: { subscriberUserId: true } } },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
    getPayoutBalanceFromLedger(userId),
    prisma.creatorPayout.aggregate({
      where: { creatorUserId: userId, status: 'pending' },
      _sum: { amountCents: true },
    }),
  ]);

  // Subtract reserved (last 14 days of earnings) and pending payouts — matches requestPayout's check
  const reserveCutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const reservedCents = ledger
    .filter(e => e.createdAt > reserveCutoff)
    .reduce((sum, e) => sum + Math.abs(e.amountCents), 0);
  const pendingCents = pendingPayoutAgg._sum.amountCents ?? 0;
  const payoutBalanceCents = Math.max(0, rawPayoutBalance - reservedCents - pendingCents);

  const mrr = activeSubscribers * creator.pricingCents;
  const churnDenominator = activeSubscribers + churnedLast30;
  const churnRatePct = churnDenominator > 0 ? Number(((churnedLast30 / churnDenominator) * 100).toFixed(2)) : 0;

  const totalEarningsCents = ledger.reduce((sum, row) => sum + row.amountCents, 0);

  const earningsByMonth = new Map<string, number>();
  for (const row of ledger) {
    const month = `${row.createdAt.getUTCFullYear()}-${String(row.createdAt.getUTCMonth() + 1).padStart(2, '0')}`;
    earningsByMonth.set(month, (earningsByMonth.get(month) || 0) + row.amountCents);
  }
  const monthlyEarnings = Array.from(earningsByMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amountCents]) => ({ month, amountCents }));

  const eventDescriptions: Record<string, string> = {
    created: 'New subscription',
    renewed: 'Subscription renewed',
    canceled: 'Subscription canceled',
    expired: 'Subscription expired',
    payment_failed: 'Payment failed',
    trial_started: 'Trial started',
  };

  return {
    mrr,
    activeSubscribers,
    churnRatePct,
    totalEarningsCents,
    payoutBalanceCents,
    monthlyEarnings,
    recentEvents: recentEvents.map((e) => ({
      type: e.eventType,
      description: eventDescriptions[e.eventType] || e.eventType,
      createdAt: e.createdAt,
    })),
  };
}

export async function getMyCreatorSubscriptions(userId: string): Promise<Array<{
  creatorUserId: string;
  status: string;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
}>> {
  const rows = await prisma.creatorSubscription.findMany({
    where: {
      subscriberUserId: userId,
      status: { in: ['active', 'past_due', 'canceled'] },
    },
    select: {
      creatorUserId: true,
      status: true,
      currentPeriodEnd: true,
      trialEnd: true,
    },
    orderBy: { updatedAt: 'desc' },
  });
  return rows;
}

export async function reportCreator(
  reporterUserId: string,
  creatorUserId: string,
  reason: string,
  description?: string
): Promise<void> {
  if (reporterUserId === creatorUserId) {
    throw new Error('Cannot report yourself');
  }
  const creator = await prisma.creator.findUnique({
    where: { userId: creatorUserId },
    select: { id: true, status: true },
  });
  if (!creator || creator.status !== 'active') {
    throw new Error('Creator not found');
  }

  // Prevent duplicate reports from same user within 24h
  const recentReport = await prisma.creatorReport.findFirst({
    where: {
      reporterUserId,
      creatorUserId,
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });
  if (recentReport) {
    throw new Error('You have already reported this creator recently');
  }

  const trimmedDesc = description?.trim().slice(0, 2000) || null;

  await prisma.creatorReport.create({
    data: {
      reporterUserId,
      creatorUserId,
      reason,
      description: trimmedDesc,
      status: 'open',
    },
  });
}

export interface CreatorSetupStatus {
  hasApplied: boolean;
  hasSetPrice: boolean;
  hasConnectedStripe: boolean;
  hasConfiguredVisibility: boolean;
  status: string | null;
}

const DEFAULT_PRICING_CENTS = 500;

export async function getCreatorSetupStatus(userId: string): Promise<CreatorSetupStatus> {
  const creator = await prisma.creator.findUnique({
    where: { userId },
    include: { visibility: true },
  });

  if (!creator) {
    return { hasApplied: false, hasSetPrice: false, hasConnectedStripe: false, hasConfiguredVisibility: false, status: null };
  }

  // Fallback: if not yet marked onboarded but has a stripeConnectId, check Stripe directly
  let hasConnectedStripe = creator.stripeConnectOnboarded;
  if (!hasConnectedStripe && creator.stripeConnectId) {
    hasConnectedStripe = await checkAndUpdateStripeConnectStatus(userId);
  }

  const v = creator.visibility;
  const hasConfiguredVisibility = v != null && (
    v.showTradeHistory || v.showRationale || v.showRiskMetrics || v.showWatchlists || !v.showHoldings || !v.showSectors
  );

  return {
    hasApplied: true,
    hasSetPrice: creator.pricingCents !== DEFAULT_PRICING_CENTS,
    hasConnectedStripe,
    hasConfiguredVisibility,
    status: creator.status,
  };
}

// ─── Discovery ────────────────────────────────────────────────

export type DiscoverSort = 'popular' | 'newest' | 'price_low' | 'price_high' | 'performance';

export interface DiscoverCreatorEntry {
  userId: string;
  username: string;
  displayName: string;
  pitch: string | null;
  pricingCents: number | null;
  subscriberCount: number;
  returnPct: number | null;
  isVerified: boolean;
  isCreator: boolean;
  sectionsUnlocked: string[];
  createdAt: string;
}

interface DiscoverCursorData {
  s: string; // sort type
  v: number | string | null; // primary sort value
  ca: string; // createdAt ISO
  u: string; // userId
}

function encodeCursor(data: DiscoverCursorData): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

function decodeCursor(cursor: string): DiscoverCursorData | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    return null;
  }
}

function deriveSectionsUnlocked(vis: {
  showHoldings: boolean;
  showTradeHistory: boolean;
  showRationale: boolean;
  showSectors: boolean;
  showRiskMetrics: boolean;
  showWatchlists: boolean;
} | null): string[] {
  if (!vis) return [];
  const sections: string[] = [];
  if (vis.showHoldings) sections.push('holdings');
  if (vis.showTradeHistory) sections.push('tradeHistory');
  if (vis.showRationale) sections.push('rationale');
  if (vis.showSectors) sections.push('sectors');
  if (vis.showRiskMetrics) sections.push('riskMetrics');
  if (vis.showWatchlists) sections.push('watchlists');
  return sections;
}

export async function discoverCreators(params: {
  limit?: number;
  cursor?: string;
  sort?: DiscoverSort;
  minPrice?: number;
  maxPrice?: number;
  search?: string;
}): Promise<{
  creators: DiscoverCreatorEntry[];
  nextCursor: string | null;
  total: number | null;
}> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const sort: DiscoverSort = params.sort ?? 'popular';

  // Build base where clause — all public, leaderboard-eligible users
  // Exclude system/seed user and test accounts
  // Note: SQLite notIn is case-sensitive; the in-memory filter below handles case-insensitive exclusion
  const EXCLUDED_USERNAMES_LOWER = new Set(['_system', 'nalainvestor']);
  const where: Record<string, unknown> = {
    profilePublic: true,
    leaderboardEligible: true,
    id: { not: '515d3ef4-2b46-4133-8c08-84327b420eba' }, // system seed user
  };

  // Price filters only apply when a creator profile exists
  if (params.minPrice != null || params.maxPrice != null) {
    const priceFilter: Record<string, number> = {};
    if (params.minPrice != null && params.minPrice > 0) priceFilter.gte = params.minPrice;
    if (params.maxPrice != null && params.maxPrice > 0) priceFilter.lte = params.maxPrice;
    where.creator = {
      status: 'active',
      visibility: { discoverable: true },
      pricingCents: priceFilter,
    };
  }

  // Search filter — match on username, displayName, or creator pitch
  if (params.search) {
    const term = params.search.trim().slice(0, 100);
    if (term) {
      where.OR = [
        { username: { contains: term } },
        { displayName: { contains: term } },
        { creator: { pitch: { contains: term } } },
      ];
    }
  }

  // Total count — only on first page (no cursor)
  const total = !params.cursor
    ? await prisma.user.count({ where: where as any })
    : null;

  const cursorData = params.cursor ? decodeCursor(params.cursor) : null;

  // Include creator + visibility data (LEFT JOIN — null for non-creators)
  const includeRelations = {
    leaderboardCaches: { where: { window: '1M' }, take: 1 },
    creator: {
      include: { visibility: true },
    },
  };

  // All sorts use in-memory approach since we're joining User + Creator + LeaderboardCache
  // and sorting on derived fields (returnPct, subscriberCount, pricingCents).
  // Cap at 500 to prevent unbounded memory usage.
  const allUsers = await prisma.user.findMany({
    where: where as any,
    include: includeRelations,
    take: 500,
  });

  // Collect creator userIds for subscriber counts
  const creatorUserIds = allUsers
    .filter((u) => u.creator?.status === 'active')
    .map((u) => u.id);
  const subCounts = creatorUserIds.length > 0
    ? await prisma.creatorSubscription.groupBy({
        by: ['creatorUserId'],
        where: {
          creatorUserId: { in: creatorUserIds },
          status: { in: ['active', 'past_due', 'trialing'] },
        },
        _count: true,
      })
    : [];
  const subCountMap = new Map(subCounts.map((s) => [s.creatorUserId, s._count]));

  // Build enriched entries
  let entries: DiscoverCreatorEntry[] = allUsers
    .filter((u) => {
      // Case-insensitive exclusion of system/test accounts (SQLite notIn is case-sensitive)
      if (EXCLUDED_USERNAMES_LOWER.has(u.username.toLowerCase())) return false;
      // Exclude creators who opted out of discovery
      if (u.creator?.status === 'active' && u.creator.visibility?.discoverable === false) {
        return false;
      }
      return true;
    })
    .map((u) => {
      const lbEntry = u.leaderboardCaches[0] ?? null;
      const creator = u.creator?.status === 'active' ? u.creator : null;
      // Trade delay: hide returnPct for creators with active delay.
      // Ranking changes reveal trading activity to observers.
      const hasDelay = creator && (creator.visibility?.tradeDelayHours ?? 0) > 0;
      return {
        userId: u.id,
        username: u.username,
        displayName: u.displayName,
        pitch: creator?.pitch ?? null,
        pricingCents: creator?.pricingCents ?? null,
        subscriberCount: subCountMap.get(u.id) ?? 0,
        returnPct: hasDelay ? null : (lbEntry?.twrPct ?? null),
        isVerified: lbEntry != null && !lbEntry.flagged,
        isCreator: creator != null,
        sectionsUnlocked: creator ? deriveSectionsUnlocked(creator.visibility) : [],
        createdAt: (creator?.createdAt ?? u.createdAt).toISOString(),
      };
    });

  // Sort in memory
  if (sort === 'popular') {
    entries.sort((a, b) =>
      b.subscriberCount - a.subscriberCount ||
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
      a.userId.localeCompare(b.userId)
    );
  } else if (sort === 'performance') {
    entries.sort((a, b) => {
      if (a.returnPct == null && b.returnPct == null) return a.userId.localeCompare(b.userId);
      if (a.returnPct == null) return 1;
      if (b.returnPct == null) return -1;
      return b.returnPct - a.returnPct || a.userId.localeCompare(b.userId);
    });
  } else if (sort === 'newest') {
    entries.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
      a.userId.localeCompare(b.userId)
    );
  } else if (sort === 'price_low') {
    // Creators with price first (ASC), then non-creators last
    entries.sort((a, b) => {
      if (a.pricingCents == null && b.pricingCents == null) return a.userId.localeCompare(b.userId);
      if (a.pricingCents == null) return 1;
      if (b.pricingCents == null) return -1;
      return a.pricingCents - b.pricingCents || a.userId.localeCompare(b.userId);
    });
  } else {
    // price_high
    entries.sort((a, b) => {
      if (a.pricingCents == null && b.pricingCents == null) return a.userId.localeCompare(b.userId);
      if (a.pricingCents == null) return 1;
      if (b.pricingCents == null) return -1;
      return b.pricingCents - a.pricingCents || a.userId.localeCompare(b.userId);
    });
  }

  // Apply cursor: skip past cursor userId
  if (cursorData) {
    const idx = entries.findIndex((e) => e.userId === cursorData.u);
    if (idx >= 0) {
      entries = entries.slice(idx + 1);
    }
  }

  // Apply limit
  const hasMore = entries.length > limit;
  entries = entries.slice(0, limit);

  const lastEntry = entries[entries.length - 1];
  const nextCursor = hasMore && lastEntry
    ? encodeCursor({
        s: sort,
        v: null,
        ca: lastEntry.createdAt,
        u: lastEntry.userId,
      })
    : null;

  return { creators: entries, nextCursor, total };
}

export async function selfActivateCreator(userId: string): Promise<{ ok: boolean; missing?: string[] }> {
  // Atomic: read + validate + update in a single transaction to prevent TOCTOU races
  return prisma.$transaction(async (tx) => {
    const creator = await tx.creator.findUnique({
      where: { userId },
      include: { visibility: true },
    });

    // Already active — idempotent success
    if (creator?.status === 'active') {
      return { ok: true };
    }

    // Suspended creators cannot self-activate
    if (creator?.status === 'suspended') {
      return { ok: false, missing: ['account_suspended'] };
    }

    // Validate all checklist items from the same read
    const missing: string[] = [];
    if (!creator) {
      missing.push('agree_to_terms');
    } else {
      if (creator.pricingCents === DEFAULT_PRICING_CENTS) missing.push('set_price');
      if (!creator.stripeConnectOnboarded) missing.push('connect_stripe');
      const v = creator.visibility;
      const hasConfiguredVisibility = v != null && (
        v.showTradeHistory || v.showRationale || v.showRiskMetrics || v.showWatchlists || !v.showHoldings || !v.showSectors
      );
      if (!hasConfiguredVisibility) missing.push('configure_visibility');
    }

    if (missing.length > 0) {
      return { ok: false, missing };
    }

    await tx.creator.update({
      where: { userId },
      data: { status: 'active' },
    });

    return { ok: true };
  });
}
