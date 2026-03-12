import prisma from '../utils/prisma';
import { PlanLimitError } from '../utils/plan-limit.error';

const PORTFOLIO_LIMITS: Record<string, number> = {
  free: 1,
  pro: 2,
  premium: 3,
  elite: 999,
};

/**
 * Get or lazily create the user's default portfolio.
 * If no default portfolio exists (pre-migration users or fresh accounts),
 * creates one copying cash/margin from UserSettings.
 */
export async function getOrCreateDefaultPortfolio(userId: string) {
  const existing = await prisma.portfolio.findFirst({
    where: { userId, isDefault: true },
  });
  if (existing) return existing;

  // Copy cash/margin from UserSettings if available
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { cashBalance: true, marginDebt: true, dripEnabled: true },
  });

  return prisma.portfolio.create({
    data: {
      userId,
      name: 'Default',
      type: 'general',
      isDefault: true,
      cashBalance: settings?.cashBalance ?? 0,
      marginDebt: settings?.marginDebt ?? 0,
      dripEnabled: settings?.dripEnabled ?? false,
    },
  });
}

/**
 * List all portfolios for a user, with holding counts.
 * Default portfolio first, then ordered by createdAt.
 */
export async function listPortfolios(userId: string) {
  const portfolios = await prisma.portfolio.findMany({
    where: { userId },
    include: {
      _count: { select: { holdings: true } },
    },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });

  return portfolios.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    isDefault: p.isDefault,
    cashBalance: p.cashBalance,
    marginDebt: p.marginDebt,
    dripEnabled: p.dripEnabled,
    holdingsCount: p._count.holdings,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

/**
 * Create a new portfolio (plan-gated).
 */
export async function createPortfolio(
  userId: string,
  input: { name: string; type?: string },
) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { plan: true },
    });
    const plan = user?.plan ?? 'free';
    const limit = PORTFOLIO_LIMITS[plan] ?? 1;

    const count = await tx.portfolio.count({ where: { userId } });
    if (count >= limit) {
      throw new PlanLimitError(limit, plan);
    }

    const created = await tx.portfolio.create({
      data: {
        userId,
        name: input.name,
        type: input.type ?? 'general',
        isDefault: false,
      },
    });

    return {
      id: created.id,
      name: created.name,
      type: created.type,
      isDefault: created.isDefault,
      cashBalance: created.cashBalance,
      marginDebt: created.marginDebt,
      dripEnabled: created.dripEnabled,
      holdingsCount: 0,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
  });
}

/**
 * Update a portfolio's name or type.
 */
export async function updatePortfolio(
  userId: string,
  portfolioId: string,
  input: { name?: string; type?: string },
) {
  const existing = await prisma.portfolio.findFirst({
    where: { id: portfolioId, userId },
  });
  if (!existing) return null;

  return prisma.portfolio.update({
    where: { id: portfolioId },
    data: {
      name: input.name ?? undefined,
      type: input.type ?? undefined,
    },
  });
}

/**
 * Delete a portfolio. Cannot delete the default. Must have 0 holdings.
 */
export async function deletePortfolio(userId: string, portfolioId: string) {
  const existing = await prisma.portfolio.findFirst({
    where: { id: portfolioId, userId },
    include: { _count: { select: { holdings: true } } },
  });
  if (!existing) return { status: 'not_found' as const };

  if (existing.isDefault) {
    return { status: 'is_default' as const };
  }

  if (existing._count.holdings > 0) {
    return { status: 'has_holdings' as const, count: existing._count.holdings };
  }

  await prisma.portfolio.delete({ where: { id: portfolioId } });
  return { status: 'deleted' as const };
}

/**
 * Set a portfolio as the default (unset all others).
 */
export async function setDefaultPortfolio(userId: string, portfolioId: string) {
  const target = await prisma.portfolio.findFirst({
    where: { id: portfolioId, userId },
  });
  if (!target) return null;

  await prisma.$transaction([
    prisma.portfolio.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    }),
    prisma.portfolio.update({
      where: { id: portfolioId },
      data: { isDefault: true },
    }),
  ]);

  return target;
}

/**
 * Get a single portfolio with holdings count (for detail view).
 */
export async function getPortfolioDetail(userId: string, portfolioId: string) {
  const portfolio = await prisma.portfolio.findFirst({
    where: { id: portfolioId, userId },
    include: { _count: { select: { holdings: true } } },
  });
  if (!portfolio) return null;

  return {
    id: portfolio.id,
    name: portfolio.name,
    type: portfolio.type,
    isDefault: portfolio.isDefault,
    cashBalance: portfolio.cashBalance,
    marginDebt: portfolio.marginDebt,
    dripEnabled: portfolio.dripEnabled,
    holdingsCount: portfolio._count.holdings,
    createdAt: portfolio.createdAt,
    updatedAt: portfolio.updatedAt,
  };
}
