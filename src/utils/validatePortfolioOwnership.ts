import prisma from './prisma';

/**
 * Validates that the given portfolioId belongs to the authenticated user.
 * If portfolioId is undefined (meaning "all portfolios"), no validation is needed.
 * Throws a 404 error if the portfolio doesn't exist or doesn't belong to the user.
 */
export async function validatePortfolioOwnership(
  portfolioId: string | undefined,
  userId: string,
): Promise<void> {
  if (!portfolioId) return; // undefined means "all" — no validation needed

  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    select: { userId: true },
  });

  if (!portfolio || portfolio.userId !== userId) {
    const err = new Error('Portfolio not found');
    (err as any).status = 404;
    throw err;
  }
}
