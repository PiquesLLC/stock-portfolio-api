import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Box-Muller transform for normal distribution
function randomNormal(mean: number, stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + stdDev * z;
}

const DEMO_USERS = [
  { username: 'alex_trades', displayName: 'Alex Chen' },
  { username: 'sarah_invest', displayName: 'Sarah Johnson' },
  { username: 'mike_portfolio', displayName: 'Mike Rivera' },
  { username: 'jess_capital', displayName: 'Jessica Park' },
  { username: 'david_stocks', displayName: 'David Kim' },
  { username: 'emma_wealth', displayName: 'Emma Thompson' },
  { username: 'ryan_markets', displayName: 'Ryan Garcia' },
  { username: 'lisa_gains', displayName: 'Lisa Nguyen' },
  { username: 'chris_alpha', displayName: 'Chris Anderson' },
  { username: 'nina_bull', displayName: 'Nina Patel' },
];

const TICKER_POOL = [
  { ticker: 'AAPL', avgCost: 175, shares: [5, 50] },
  { ticker: 'MSFT', avgCost: 380, shares: [3, 30] },
  { ticker: 'GOOGL', avgCost: 140, shares: [5, 40] },
  { ticker: 'AMZN', avgCost: 180, shares: [3, 30] },
  { ticker: 'NVDA', avgCost: 480, shares: [2, 20] },
  { ticker: 'META', avgCost: 490, shares: [2, 20] },
  { ticker: 'TSLA', avgCost: 250, shares: [5, 40] },
  { ticker: 'JPM', avgCost: 195, shares: [5, 30] },
  { ticker: 'V', avgCost: 275, shares: [3, 25] },
  { ticker: 'JNJ', avgCost: 155, shares: [5, 40] },
  { ticker: 'WMT', avgCost: 165, shares: [5, 35] },
  { ticker: 'PG', avgCost: 160, shares: [5, 30] },
  { ticker: 'XOM', avgCost: 105, shares: [10, 50] },
  { ticker: 'KO', avgCost: 60, shares: [10, 80] },
  { ticker: 'DIS', avgCost: 95, shares: [10, 50] },
  { ticker: 'NFLX', avgCost: 600, shares: [1, 10] },
  { ticker: 'AMD', avgCost: 155, shares: [5, 40] },
  { ticker: 'COST', avgCost: 730, shares: [1, 8] },
  { ticker: 'BA', avgCost: 195, shares: [3, 20] },
  { ticker: 'INTC', avgCost: 30, shares: [20, 100] },
  { ticker: 'CRM', avgCost: 270, shares: [3, 20] },
  { ticker: 'PYPL', avgCost: 65, shares: [10, 50] },
  { ticker: 'UBER', avgCost: 70, shares: [10, 60] },
  { ticker: 'SQ', avgCost: 75, shares: [5, 40] },
  { ticker: 'PLTR', avgCost: 22, shares: [30, 200] },
  { ticker: 'SOFI', avgCost: 9, shares: [50, 300] },
  { ticker: 'NKE', avgCost: 95, shares: [5, 40] },
  { ticker: 'SBUX', avgCost: 95, shares: [5, 35] },
  { ticker: 'T', avgCost: 17, shares: [30, 150] },
  { ticker: 'F', avgCost: 12, shares: [30, 200] },
];

function pickRandom<T>(arr: T[], count: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  console.log('Seeding demo users...');

  // Clean up existing demo data
  await prisma.portfolioSnapshot.deleteMany({ where: { userId: { not: null } } });
  await prisma.holding.deleteMany({ where: { userId: { not: null } } });
  await prisma.userSettings.deleteMany();
  await prisma.user.deleteMany();

  for (const userData of DEMO_USERS) {
    const user = await prisma.user.create({
      data: {
        username: userData.username,
        displayName: userData.displayName,
      },
    });

    // Pick 5-15 random holdings
    const holdingCount = randInt(5, 15);
    const selectedTickers = pickRandom(TICKER_POOL, holdingCount);
    let totalHoldingsValue = 0;

    for (const stock of selectedTickers) {
      const shares = randInt(stock.shares[0], stock.shares[1]);
      // Vary the average cost ±20%
      const avgCost = stock.avgCost * (0.8 + Math.random() * 0.4);

      await prisma.holding.create({
        data: {
          ticker: stock.ticker,
          shares,
          averageCost: Math.round(avgCost * 100) / 100,
          userId: user.id,
        },
      });

      totalHoldingsValue += shares * avgCost;
    }

    // Random cash balance
    const cashBalance = randInt(5000, 50000);
    const marginDebt = Math.random() > 0.7 ? randInt(1000, 10000) : 0;

    await prisma.userSettings.create({
      data: {
        userId: user.id,
        cashBalance,
        marginDebt,
      },
    });

    // Generate 90 daily snapshots using random walk
    const initialAssets = totalHoldingsValue + cashBalance;
    let currentValue = initialAssets;
    const now = new Date();

    // Each user gets slightly different drift and volatility for variety
    const userDrift = 0.0003 + (Math.random() - 0.5) * 0.001; // ~7% annual ± some
    const userVol = 0.012 + Math.random() * 0.008; // 12-20% daily vol basis

    for (let day = 89; day >= 0; day--) {
      const snapshotDate = new Date(now);
      snapshotDate.setDate(snapshotDate.getDate() - day);
      snapshotDate.setHours(16, 0, 0, 0); // Market close

      // Skip weekends
      const dow = snapshotDate.getDay();
      if (dow === 0 || dow === 6) continue;

      const dailyReturn = randomNormal(userDrift, userVol);
      currentValue = currentValue * (1 + dailyReturn);

      // Compute daily P&L vs previous
      const prevValue = currentValue / (1 + dailyReturn);
      const dailyPL = currentValue - prevValue;
      const dailyPLPercent = prevValue > 0 ? (dailyPL / prevValue) * 100 : 0;

      const totalPL = currentValue - initialAssets;
      const totalPLPercent = initialAssets > 0 ? (totalPL / initialAssets) * 100 : 0;

      await prisma.portfolioSnapshot.create({
        data: {
          timestamp: snapshotDate,
          totalValue: Math.round(currentValue * 100) / 100,
          cashBalance,
          dailyPL: Math.round(dailyPL * 100) / 100,
          dailyPLPercent: Math.round(dailyPLPercent * 100) / 100,
          totalPL: Math.round(totalPL * 100) / 100,
          totalPLPercent: Math.round(totalPLPercent * 100) / 100,
          userId: user.id,
        },
      });
    }

    console.log(`  Created user ${userData.displayName} with ${holdingCount} holdings and ~90 snapshots`);
  }

  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
