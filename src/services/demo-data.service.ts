import prisma from '../utils/prisma';
import { subSectorGroups } from '../utils/sectors';
import { backfillDemoUserSnapshots } from './snapshot.service';
import { followUser } from './follow.service';
import { fetchPrices } from './market.service';

const DEFAULT_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

function pickRandom<T>(arr: T[], count: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Tickers to exclude from demo data: delisted, renamed, or extreme prices
const EXCLUDED_TICKERS = new Set(['HES', 'SQ', 'BRK.A']);

function collectHeatmapTickers(): string[] {
  const tickers: string[] = [];
  for (const sector of Object.values(subSectorGroups)) {
    for (const list of Object.values(sector)) {
      for (const t of list) {
        const upper = t.toUpperCase();
        if (!EXCLUDED_TICKERS.has(upper)) tickers.push(upper);
      }
    }
  }
  return Array.from(new Set(tickers));
}

export async function ensureLeaderboardUsersHaveHoldings(): Promise<{ filled: number; skipped: number }> {
  const users = await prisma.user.findMany({
    where: {
      leaderboardEligible: true,
      id: { not: DEFAULT_USER_ID },
    },
    select: { id: true, displayName: true },
  });

  if (users.length === 0) return { filled: 0, skipped: 0 };

  const tickerPool = collectHeatmapTickers();
  let filled = 0;
  let skipped = 0;

  for (const user of users) {
    const existing = await prisma.holding.count({ where: { userId: user.id } });
    if (existing > 0) {
      skipped++;
      continue;
    }

    const holdingCount = randInt(6, 14);
    const selected = pickRandom(tickerPool, holdingCount);

    // Fetch real prices so avgCost is realistic (±20% of current price)
    const quotesResult = await fetchPrices(selected).catch(() => null);
    const priceMap = new Map<string, number>();
    if (quotesResult) {
      for (const [ticker, q] of quotesResult.quotes) {
        if (q.currentPrice > 0) priceMap.set(ticker, q.currentPrice);
      }
    }

    await prisma.holding.createMany({
      data: selected
        .filter(ticker => priceMap.has(ticker)) // only include tickers with valid prices
        .map((ticker) => {
          const currentPrice = priceMap.get(ticker)!;
          // Random avgCost within ±20% of current price for realistic P/L
          const variance = 0.8 + Math.random() * 0.4; // 0.8 to 1.2
          const avgCost = currentPrice * variance;
          const shares = randInt(2, 60);
          return {
            userId: user.id,
            ticker,
            shares,
            averageCost: Math.round(avgCost * 100) / 100,
          };
        }),
    });

    const cashBalance = 0;
    const marginDebt = 0;
    await prisma.userSettings.upsert({
      where: { userId: user.id },
      update: { cashBalance, marginDebt },
      create: { userId: user.id, cashBalance, marginDebt },
    });

    filled++;
    console.log(`[Demo Holdings] Created holdings for ${user.displayName ?? user.id}`);
  }

  console.log(`[Demo Holdings] Done: ${filled} filled, ${skipped} skipped`);
  return { filled, skipped };
}

export async function seedLeaderboardActivityEvents(
  options: { force?: boolean } = {}
): Promise<{ seeded: number; skipped: number }> {
  const users = await prisma.user.findMany({
    where: {
      leaderboardEligible: true,
      id: { not: DEFAULT_USER_ID },
    },
    select: { id: true, displayName: true },
  });

  if (users.length === 0) return { seeded: 0, skipped: 0 };

  let seeded = 0;
  let skipped = 0;
  const force = options.force ?? false;

  for (const user of users) {
    if (force) {
      await prisma.activityEvent.deleteMany({ where: { userId: user.id } });
    } else {
      const existing = await prisma.activityEvent.count({ where: { userId: user.id } });
      if (existing > 0) {
        skipped++;
        continue;
      }
    }

    const holdings = await prisma.holding.findMany({
      where: { userId: user.id },
      select: { ticker: true },
    });
    if (holdings.length === 0) {
      skipped++;
      continue;
    }

    const tickers = holdings.map(h => h.ticker);
    const eventCount = randInt(18, 35);
    const events = [];

    for (let i = 0; i < eventCount; i++) {
      const ticker = tickers[randInt(0, tickers.length - 1)];
      const roll = Math.random();
      const type = roll < 0.25 ? 'holding_added' : roll < 0.9 ? 'holding_updated' : 'holding_removed';

      const shares = randInt(1, 50);
      const previousShares = randInt(1, 50);
      const averageCost = Math.round((randInt(10, 500) + Math.random()) * 100) / 100;

      const payload =
        type === 'holding_added'
          ? { ticker, shares, averageCost }
          : type === 'holding_updated'
            ? { ticker, shares, previousShares, averageCost }
            : { ticker, previousShares };

      const createdAt = new Date();
      createdAt.setDate(createdAt.getDate() - randInt(0, 45));
      createdAt.setHours(randInt(9, 16), randInt(0, 59), randInt(0, 59), 0);

      events.push({
        userId: user.id,
        type,
        payload: JSON.stringify(payload),
        createdAt,
      });
    }

    await prisma.activityEvent.createMany({ data: events });
    seeded++;
    console.log(`[Demo Activity] Seeded events for ${user.displayName ?? user.id}`);
  }

  console.log(`[Demo Activity] Done: ${seeded} seeded, ${skipped} skipped`);
  return { seeded, skipped };
}

export async function reseedLeaderboardActivityEvents(): Promise<void> {
  await seedLeaderboardActivityEvents({ force: true });
}

export async function seedLeaderboardFollows(
  options: { force?: boolean } = {}
): Promise<{ seeded: number; skipped: number }> {
  const users = await prisma.user.findMany({
    where: {
      leaderboardEligible: true,
      id: { not: DEFAULT_USER_ID },
    },
    select: { id: true, displayName: true },
  });

  if (users.length === 0) return { seeded: 0, skipped: 0 };

  if (options.force) {
    await prisma.follow.deleteMany({
      where: {
        OR: [
          { followerId: DEFAULT_USER_ID },
          { followerId: { in: users.map(u => u.id) } },
        ],
      },
    });
  }

  let seeded = 0;
  let skipped = 0;

  // System user follows all leaderboard users so the feed has activity.
  for (const user of users) {
    try {
      await followUser(DEFAULT_USER_ID, user.id);
      seeded++;
    } catch {
      skipped++;
    }
  }

  // Each demo user follows 3-5 other demo users for richer social graphs.
  for (const user of users) {
    const candidates = users.filter(u => u.id !== user.id);
    const count = Math.min(candidates.length, randInt(3, 5));
    const targets = pickRandom(candidates, count);
    for (const target of targets) {
      try {
        await followUser(user.id, target.id);
        seeded++;
      } catch {
        skipped++;
      }
    }
  }

  console.log(`[Demo Follows] Done: ${seeded} seeded, ${skipped} skipped`);
  return { seeded, skipped };
}

export async function backfillLeaderboardDemoData(): Promise<void> {
  await ensureLeaderboardUsersHaveHoldings();
  await backfillDemoUserSnapshots();
  await seedLeaderboardActivityEvents();
}
