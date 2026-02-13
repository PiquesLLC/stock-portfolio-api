import prisma from '../utils/prisma';
import { subSectorGroups } from '../utils/sectors';
import { backfillDemoUserSnapshots } from './snapshot.service';

const DEFAULT_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

function pickRandom<T>(arr: T[], count: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function collectHeatmapTickers(): string[] {
  const tickers: string[] = [];
  for (const sector of Object.values(subSectorGroups)) {
    for (const list of Object.values(sector)) {
      for (const t of list) tickers.push(t.toUpperCase());
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

    await prisma.holding.createMany({
      data: selected.map((ticker) => {
        const avgCost = randInt(10, 500) + Math.random();
        const shares = randInt(2, 60);
        return {
          userId: user.id,
          ticker,
          shares,
          averageCost: Math.round(avgCost * 100) / 100,
        };
      }),
    });

    const cashBalance = randInt(5000, 50000);
    const marginDebt = Math.random() > 0.7 ? randInt(1000, 10000) : 0;
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

export async function seedLeaderboardActivityEvents(): Promise<{ seeded: number; skipped: number }> {
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

  for (const user of users) {
    const existing = await prisma.activityEvent.count({ where: { userId: user.id } });
    if (existing > 0) {
      skipped++;
      continue;
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
    const eventCount = randInt(10, 25);
    const events = [];

    for (let i = 0; i < eventCount; i++) {
      const ticker = tickers[randInt(0, tickers.length - 1)];
      const roll = Math.random();
      const type = roll < 0.4 ? 'holding_added' : roll < 0.85 ? 'holding_updated' : 'holding_removed';

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
      createdAt.setDate(createdAt.getDate() - randInt(0, 30));
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

export async function backfillLeaderboardDemoData(): Promise<void> {
  await ensureLeaderboardUsersHaveHoldings();
  await backfillDemoUserSnapshots();
  await seedLeaderboardActivityEvents();
}
