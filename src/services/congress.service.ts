import prisma from '../utils/prisma';
import { config } from '../config';

const FMP_BASE = 'https://financialmodelingprep.com/stable';

interface FmpCongressTrade {
  symbol: string;
  disclosureDate: string;
  transactionDate: string;
  firstName: string;
  lastName: string;
  office: string;
  district: string;
  owner: string;
  assetDescription: string;
  assetType: string;
  type: string; // Purchase, Sale, Exchange
  amount: string; // "$1,001 - $15,000"
  comment: string;
  link: string;
}

// ── Parse amount range string ──────────────────────────────────

function parseAmountRange(amount: string): { low: number; high: number } {
  const cleaned = amount.replace(/[$,]/g, '');
  const match = cleaned.match(/([\d.]+)\s*-\s*([\d.]+)/);
  if (match) return { low: parseFloat(match[1]), high: parseFloat(match[2]) };
  const single = parseFloat(cleaned);
  return { low: single || 0, high: single || 0 };
}

// ── Infer chamber from district code ───────────────────────────

function inferChamber(district: string): string {
  // Senate entries have state abbreviation only (e.g., "OK", "AR")
  // House entries have state + district number (e.g., "LA06", "NJ07")
  if (!district) return 'Unknown';
  return district.length <= 2 ? 'Senate' : 'House';
}

// ── FMP fetch ──────────────────────────────────────────────────

async function fetchFmpTrades(endpoint: string): Promise<FmpCongressTrade[]> {
  const apiKey = config.fmpApiKey || '';
  if (!apiKey) return [];
  const url = `${FMP_BASE}/${endpoint}?apikey=${apiKey}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as FmpCongressTrade[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// ── QuiverQuant fetch (placeholder — activate when subscribed) ──

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _fetchQuiverTrades(): Promise<FmpCongressTrade[]> {
  // TODO: Implement when QuiverQuant API key is available
  // const url = `https://api.quiverquant.com/beta/live/congresstrading`;
  // headers: { Authorization: `Bearer ${config.quiverQuantApiKey}` }
  return [];
}

// ── Sync latest trades from FMP into DB ────────────────────────

export async function syncLatestCongressTrades(): Promise<number> {
  const [senateTrades, houseTrades] = await Promise.all([
    fetchFmpTrades('senate-latest'),
    fetchFmpTrades('house-latest'),
  ]);

  const allTrades = [...senateTrades, ...houseTrades];
  if (allTrades.length === 0) return 0;

  let upserted = 0;
  for (const t of allTrades) {
    if (!t.transactionDate || !t.lastName || !t.symbol) continue;
    const politician = `${t.firstName} ${t.lastName}`.trim();
    const { low, high } = parseAmountRange(t.amount);
    try {
      await prisma.congressTrade.upsert({
        where: {
          politician_ticker_tradeDate_transactionType: {
            politician,
            ticker: t.symbol.toUpperCase(),
            tradeDate: new Date(t.transactionDate),
            transactionType: t.type || 'Unknown',
          },
        },
        update: {
          filingDate: t.disclosureDate ? new Date(t.disclosureDate) : new Date(),
          amountFrom: low,
          amountTo: high,
          assetName: t.assetDescription || null,
          ownerType: t.owner || null,
          fetchedAt: new Date(),
        },
        create: {
          politician,
          chamber: inferChamber(t.district),
          ticker: t.symbol.toUpperCase(),
          transactionType: t.type || 'Unknown',
          amountFrom: low,
          amountTo: high,
          tradeDate: new Date(t.transactionDate),
          filingDate: t.disclosureDate ? new Date(t.disclosureDate) : new Date(),
          assetName: t.assetDescription || null,
          ownerType: t.owner || null,
          source: 'fmp',
        },
      });
      upserted++;
    } catch {
      // Duplicate or invalid data — skip
    }
  }
  return upserted;
}

// ── Query trades from DB ───────────────────────────────────────

export async function getRecentCongressTrades(options?: {
  ticker?: string;
  chamber?: string;
  transactionType?: string;
  limit?: number;
  offset?: number;
}) {
  const { ticker, chamber, transactionType, limit = 50, offset = 0 } = options || {};

  const where: Record<string, unknown> = {};
  if (ticker) where.ticker = ticker.toUpperCase();
  if (chamber) where.chamber = chamber;
  if (transactionType) where.transactionType = transactionType;

  const [trades, total] = await Promise.all([
    prisma.congressTrade.findMany({
      where,
      orderBy: { tradeDate: 'desc' },
      take: Math.min(limit, 100),
      skip: offset,
    }),
    prisma.congressTrade.count({ where }),
  ]);

  return { trades, total };
}

async function ensureFreshData(): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 3600000);
  const fresh = await prisma.congressTrade.findFirst({
    where: { fetchedAt: { gte: oneHourAgo } },
  });
  if (!fresh) {
    await syncLatestCongressTrades();
  }
}

export async function getCongressTradesForPortfolio(userId: string) {
  const holdings = await prisma.holding.findMany({
    where: { userId },
    select: { ticker: true },
  });
  const tickers = holdings.map(h => h.ticker);
  if (tickers.length === 0) return { trades: [], total: 0, tickers: [] };

  await ensureFreshData();

  const cutoff = new Date(Date.now() - 90 * 86400000);
  const [trades, total] = await Promise.all([
    prisma.congressTrade.findMany({
      where: { ticker: { in: tickers }, tradeDate: { gte: cutoff } },
      orderBy: { tradeDate: 'desc' },
      take: 50,
    }),
    prisma.congressTrade.count({
      where: { ticker: { in: tickers }, tradeDate: { gte: cutoff } },
    }),
  ]);

  return { trades, total, tickers };
}

export async function getCongressTradesForTicker(ticker: string) {
  await ensureFreshData();

  return prisma.congressTrade.findMany({
    where: { ticker: ticker.toUpperCase() },
    orderBy: { tradeDate: 'desc' },
    take: 100,
  });
}

export async function getCongressStats() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);

  const [mostBought, mostSold, topTraders] = await Promise.all([
    prisma.$queryRaw<{ ticker: string; count: number }[]>`
      SELECT ticker, COUNT(*) as count FROM CongressTrade
      WHERE transactionType = 'Purchase' AND tradeDate >= ${thirtyDaysAgo}
      GROUP BY ticker ORDER BY count DESC LIMIT 10`,
    prisma.$queryRaw<{ ticker: string; count: number }[]>`
      SELECT ticker, COUNT(*) as count FROM CongressTrade
      WHERE transactionType LIKE '%Sale%' AND tradeDate >= ${thirtyDaysAgo}
      GROUP BY ticker ORDER BY count DESC LIMIT 10`,
    prisma.$queryRaw<{ politician: string; count: number }[]>`
      SELECT politician, COUNT(*) as count FROM CongressTrade
      WHERE tradeDate >= ${thirtyDaysAgo}
      GROUP BY politician ORDER BY count DESC LIMIT 10`,
  ]);

  return { mostBought, mostSold, topTraders };
}
