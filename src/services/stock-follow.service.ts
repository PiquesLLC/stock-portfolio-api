import prisma from '../utils/prisma';

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function isValidSymbol(symbol: string): boolean {
  return /^[A-Z0-9.\-]{1,15}$/.test(symbol);
}

export async function followStock(userId: string, rawSymbol: string): Promise<void> {
  const symbol = normalizeSymbol(rawSymbol);
  await prisma.stockFollow.upsert({
    where: { userId_symbol: { userId, symbol } },
    update: {},
    create: { userId, symbol },
  });
}

export async function unfollowStock(userId: string, rawSymbol: string): Promise<void> {
  const symbol = normalizeSymbol(rawSymbol);
  await prisma.stockFollow.deleteMany({
    where: { userId, symbol },
  });
}

export async function getStockFollowStatus(
  userId: string | undefined,
  rawSymbol: string,
): Promise<{ following: boolean; followerCount: number }> {
  const symbol = normalizeSymbol(rawSymbol);
  const [followerCount, follow] = await Promise.all([
    prisma.stockFollow.count({ where: { symbol } }),
    userId
      ? prisma.stockFollow.findUnique({
          where: { userId_symbol: { userId, symbol } },
        })
      : Promise.resolve(null),
  ]);

  return {
    following: !!follow,
    followerCount,
  };
}

export async function getMostFollowedStocks(limit = 100): Promise<Array<{ symbol: string; followerCount: number }>> {
  const rows = await prisma.stockFollow.groupBy({
    by: ['symbol'],
    _count: { symbol: true },
    orderBy: { _count: { symbol: 'desc' } },
    take: Math.max(1, Math.min(limit, 500)),
  });

  return rows.map((row) => ({
    symbol: row.symbol,
    followerCount: row._count.symbol,
  }));
}

export async function getMyFollowedSymbols(userId: string): Promise<string[]> {
  const rows = await prisma.stockFollow.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { symbol: true },
  });
  return rows.map((row) => row.symbol);
}

