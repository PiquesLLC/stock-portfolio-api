import prisma from '../utils/prisma';

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

const VALID_PRICING = new Set([500, 1500, 4900]);
const VALID_TRADE_DELAY_HOURS = new Set([0, 24, 48, 72]);
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
          tradeDelayHours: 0,
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
          // Null period end can occur briefly for a just-created Stripe subscription;
          // allow access until Stripe writes the first billing-cycle boundary.
          { currentPeriodEnd: null },
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
  if (!creator || creator.status !== 'active') return null;

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
    stripeConnectOnboarded: creator.stripeConnectOnboarded,
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
};

export async function updateCreatorSettings(userId: string, settings: CreatorSettingsInput): Promise<void> {
  if (settings.pricingCents !== undefined && !VALID_PRICING.has(settings.pricingCents)) {
    throw new Error('Invalid pricing');
  }
  if (settings.tradeDelayHours !== undefined && !VALID_TRADE_DELAY_HOURS.has(settings.tradeDelayHours)) {
    throw new Error('Invalid trade delay');
  }

  const creator = await prisma.creator.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!creator) {
    throw new Error('Creator not found');
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
      return holdings.map((h) => ({
        ticker: h.ticker,
        shares: hideShareCount ? 0 : h.shares,
        averageCost: hideShareCount ? 0 : h.averageCost,
        createdAt: h.createdAt,
      }));
    }
    case 'tradeHistory': {
      const tx = await prisma.transaction.findMany({
        where: {
          userId: creatorUserId,
          date: { lte: tradeDelayCutoff },
        },
        orderBy: { date: 'desc' },
        take: 200,
      });
      return tx;
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
  mrrCents: number;
  activeSubscribers: number;
  churnRatePct: number;
  payoutBalanceCents: number;
  earningsChart: Array<{ month: string; amountCents: number }>;
  recentEvents: Array<{ eventType: string; createdAt: Date; subscriberUserId: string }>;
}> {
  const creator = await prisma.creator.findUnique({
    where: { userId },
    select: { pricingCents: true, id: true },
  });
  if (!creator) throw new Error('Creator not found');

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [activeSubscribers, churnedLast30, ledger, recentEvents, payoutBalanceCents] = await Promise.all([
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
  ]);

  const mrrCents = activeSubscribers * creator.pricingCents;
  const churnDenominator = activeSubscribers + churnedLast30;
  const churnRatePct = churnDenominator > 0 ? Number(((churnedLast30 / churnDenominator) * 100).toFixed(2)) : 0;

  const earningsByMonth = new Map<string, number>();
  for (const row of ledger) {
    const month = `${row.createdAt.getUTCFullYear()}-${String(row.createdAt.getUTCMonth() + 1).padStart(2, '0')}`;
    earningsByMonth.set(month, (earningsByMonth.get(month) || 0) + row.amountCents);
  }
  const earningsChart = Array.from(earningsByMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amountCents]) => ({ month, amountCents }));

  return {
    mrrCents,
    activeSubscribers,
    churnRatePct,
    payoutBalanceCents,
    earningsChart,
    recentEvents: recentEvents.map((e) => ({
      eventType: e.eventType,
      createdAt: e.createdAt,
      subscriberUserId: e.subscription.subscriberUserId,
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

  await prisma.creatorReport.create({
    data: {
      reporterUserId,
      creatorUserId,
      reason,
      description: description?.trim() || null,
      status: 'open',
    },
  });
}
