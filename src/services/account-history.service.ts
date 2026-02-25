import prisma from '../utils/prisma';

export type HistoryCategory = 'trade' | 'cash' | 'adjustment';

export interface AccountHistoryEntry {
  id: string;
  source: 'activity' | 'trade' | 'ledger';
  category: HistoryCategory;
  type: string;
  ticker: string | null;
  shares: number | null;
  price: number | null;
  amount: number | null;
  date: string;
  description: string;
  sourceBroker: string | null;
}

// ── Source priority for deterministic sort tiebreaker ──────────────
// Sort order: date DESC, sourcePriority ASC, id DESC
const SOURCE_PRIORITY: Record<string, number> = { activity: 0, trade: 1, ledger: 2 };

// ── Canonical category mapping ────────────────────────────────────
// Each event type maps to EXACTLY ONE category. No overlaps.
//
//   trade:      ActivityEvent (all types) + PortfolioTrade (buy, sell)
//   cash:       LedgerEvent (DEPOSIT, WITHDRAWAL, CASH_DIVIDEND, INTEREST, FEE)
//   adjustment: PortfolioTrade (split, merger, transfer, cancel) + LedgerEvent (DIV_REINVEST)

const TRADE_PORTFOLIO_TYPES = new Set(['buy', 'sell']);
const ADJUSTMENT_PORTFOLIO_TYPES = new Set(['split', 'merger', 'transfer', 'cancel']);
const CASH_LEDGER_TYPES = new Set(['DEPOSIT', 'WITHDRAWAL', 'CASH_DIVIDEND', 'INTEREST', 'FEE']);
const ADJUSTMENT_LEDGER_TYPES = new Set(['DIV_REINVEST']);

function getActivityCategory(_type: string): HistoryCategory {
  return 'trade'; // all ActivityEvent types are categorized as trade
}

function getTradeCategory(type: string): HistoryCategory {
  if (ADJUSTMENT_PORTFOLIO_TYPES.has(type)) return 'adjustment';
  return 'trade'; // buy, sell, and any unknown default to trade
}

function getLedgerCategory(eventType: string): HistoryCategory {
  if (ADJUSTMENT_LEDGER_TYPES.has(eventType)) return 'adjustment';
  return 'cash'; // DEPOSIT, WITHDRAWAL, CASH_DIVIDEND, INTEREST, FEE, and unknown
}

// ── Signed amount semantics ───────────────────────────────────────
// Positive = money/value in, Negative = money/value out, null = no cash movement

function signedTradeAmount(type: string, shares: number, price: number): number | null {
  switch (type) {
    case 'buy': return -(shares * price);
    case 'sell': return shares * price;
    default: return null; // split, merger, transfer, cancel — no cash movement
  }
}

function signedLedgerAmount(eventType: string, rawAmount: number): number | null {
  switch (eventType) {
    case 'DEPOSIT': return Math.abs(rawAmount);
    case 'WITHDRAWAL': return -Math.abs(rawAmount);
    case 'CASH_DIVIDEND': return Math.abs(rawAmount);
    case 'INTEREST': return Math.abs(rawAmount);
    case 'FEE': return -Math.abs(rawAmount);
    case 'MARGIN_BORROW': return Math.abs(rawAmount);
    case 'MARGIN_REPAY': return -Math.abs(rawAmount);
    case 'DIV_REINVEST': return null; // no cash movement
    default: return rawAmount;
  }
}

// ── Description builders ──────────────────────────────────────────

function fmt(n: number): string {
  return n.toFixed(2);
}

function buildActivityDescription(type: string, payload: Record<string, unknown>): string {
  const ticker = String(payload.ticker ?? '');
  const shares = Number(payload.shares ?? 0);
  const previousShares = Number(payload.previousShares ?? 0);
  const averageCost = Number(payload.averageCost ?? 0);

  switch (type) {
    case 'holding_added':
      return `Added ${shares} ${ticker} @ $${fmt(averageCost)}`;
    case 'holding_removed':
      return `Removed ${ticker}`;
    case 'holding_updated':
      return `Updated ${ticker}: ${previousShares} \u2192 ${shares} shares`;
    default:
      return `${type}: ${ticker}`;
  }
}

function buildTradeDescription(type: string, ticker: string, shares: number, price: number): string {
  switch (type) {
    case 'buy':
      return `Bought ${shares} ${ticker} @ $${fmt(price)}`;
    case 'sell':
      return `Sold ${shares} ${ticker} @ $${fmt(price)}`;
    case 'split':
      return `Stock split: +${shares} ${ticker}`;
    case 'transfer':
      return `Transferred in ${shares} ${ticker}`;
    case 'merger':
      return `Merger: received ${shares} ${ticker}`;
    case 'cancel':
      return `Cancelled: ${shares} ${ticker}`;
    default:
      return `${type}: ${shares} ${ticker}`;
  }
}

function buildLedgerDescription(eventType: string, ticker: string | null, amount: number, shares: number | null): string {
  switch (eventType) {
    case 'DEPOSIT':
      return `Deposit $${fmt(Math.abs(amount))}`;
    case 'WITHDRAWAL':
      return `Withdrawal $${fmt(Math.abs(amount))}`;
    case 'CASH_DIVIDEND':
      return `Dividend: ${ticker ?? 'Unknown'} $${fmt(Math.abs(amount))}`;
    case 'INTEREST':
      return `Interest $${fmt(Math.abs(amount))}`;
    case 'FEE':
      return `Fee -$${fmt(Math.abs(amount))}`;
    case 'DIV_REINVEST':
      return `Dividend reinvested: ${shares ?? 0} ${ticker ?? 'Unknown'}`;
    case 'MARGIN_BORROW':
      return `Margin borrow $${fmt(Math.abs(amount))}`;
    case 'MARGIN_REPAY':
      return `Margin repay $${fmt(Math.abs(amount))}`;
    default:
      return `${eventType}: $${fmt(Math.abs(amount))}`;
  }
}

// ── Category-to-type DB filters ───────────────────────────────────

function activityTypesForCategory(category?: HistoryCategory): string[] | null {
  if (!category || category === 'trade') return null; // all activity = trade
  return []; // cash and adjustment have no activity events
}

function tradeTypesForCategory(category?: HistoryCategory): string[] | null {
  if (!category) return null;
  if (category === 'trade') return ['buy', 'sell'];
  if (category === 'adjustment') return ['split', 'merger', 'transfer', 'cancel'];
  return []; // cash
}

function ledgerTypesForCategory(category?: HistoryCategory): string[] | null {
  if (!category) return null;
  if (category === 'cash') return ['DEPOSIT', 'WITHDRAWAL', 'CASH_DIVIDEND', 'INTEREST', 'FEE'];
  if (category === 'adjustment') return ['DIV_REINVEST'];
  return []; // trade
}

// ── Composite cursor (date|source|id) ─────────────────────────────

interface ParsedCursor {
  date: Date;
  source: string;
  id: string;
}

function parseCursor(raw: string): ParsedCursor | null {
  const idx1 = raw.indexOf('|');
  if (idx1 < 0) return null;
  const idx2 = raw.indexOf('|', idx1 + 1);
  if (idx2 < 0) return null;
  const dateStr = raw.slice(0, idx1);
  const source = raw.slice(idx1 + 1, idx2);
  const id = raw.slice(idx2 + 1);
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  if (!(source in SOURCE_PRIORITY)) return null;
  if (!id) return null;
  return { date, source, id };
}

function buildCursor(entry: AccountHistoryEntry): string {
  return `${entry.date}|${entry.source}|${entry.id}`;
}

/**
 * Compare two entries for deterministic sort.
 * Returns negative if a sorts before b (appears earlier in results).
 * Sort order: date DESC, source priority ASC, id DESC.
 */
function compareEntries(
  a: { date: string; source: string; id: string },
  b: { date: string; source: string; id: string },
): number {
  // Primary: date DESC
  const da = new Date(a.date).getTime();
  const db = new Date(b.date).getTime();
  if (da !== db) return db - da;
  // Secondary: source priority ASC
  const pa = SOURCE_PRIORITY[a.source] ?? 99;
  const pb = SOURCE_PRIORITY[b.source] ?? 99;
  if (pa !== pb) return pa - pb;
  // Tertiary: id DESC (lexicographic)
  if (a.id > b.id) return -1;
  if (a.id < b.id) return 1;
  return 0;
}

// ── Main query ────────────────────────────────────────────────────

export async function getAccountHistory(params: {
  userId: string;
  limit?: number;
  cursor?: string;
  category?: HistoryCategory;
  ticker?: string;
}): Promise<{
  entries: AccountHistoryEntry[];
  nextCursor: string | null;
}> {
  const { userId, category } = params;
  const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);
  const ticker = params.ticker?.trim().toUpperCase() || undefined;

  // Parse composite cursor
  const parsed = params.cursor ? parseCursor(params.cursor) : null;
  const cursorDate = parsed?.date ?? null;

  // Category-based type filters pushed into DB queries
  const activityTypes = activityTypesForCategory(category);
  const tradeTypes = tradeTypesForCategory(category);
  const ledgerTypes = ledgerTypesForCategory(category);

  // Fetch (limit+1)*2 per source to account for pre-cursor entries we discard after merge
  const fetchLimit = (limit + 1) * 2;

  // Query all three tables in parallel with indexed filters
  const [activityEvents, portfolioTrades, ledgerEvents] = await Promise.all([
    // ActivityEvent — only if category allows
    activityTypes === null || activityTypes.length > 0
      ? prisma.activityEvent.findMany({
          where: {
            userId,
            ...(cursorDate ? { createdAt: { lte: cursorDate } } : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: fetchLimit,
        })
      : Promise.resolve([]),

    // PortfolioTrade — only if category allows
    tradeTypes === null || tradeTypes.length > 0
      ? prisma.portfolioTrade.findMany({
          where: {
            userId,
            ...(cursorDate ? { date: { lte: cursorDate } } : {}),
            ...(tradeTypes ? { type: { in: tradeTypes } } : {}),
            ...(ticker ? { ticker } : {}),
          },
          orderBy: [{ date: 'desc' }, { id: 'desc' }],
          take: fetchLimit,
        })
      : Promise.resolve([]),

    // LedgerEvent — only if category allows
    ledgerTypes === null || ledgerTypes.length > 0
      ? prisma.ledgerEvent.findMany({
          where: {
            userId,
            ...(cursorDate ? { effectiveDate: { lte: cursorDate } } : {}),
            ...(ledgerTypes ? { eventType: { in: ledgerTypes } } : {}),
            ...(ticker ? { ticker } : {}),
          },
          orderBy: [{ effectiveDate: 'desc' }, { id: 'desc' }],
          take: fetchLimit,
        })
      : Promise.resolve([]),
  ]);

  // Map ActivityEvent → entries
  let activityEntries: AccountHistoryEntry[] = activityEvents.map((e) => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(e.payload); } catch { /* malformed */ }
    return {
      id: e.id,
      source: 'activity' as const,
      category: getActivityCategory(e.type),
      type: e.type,
      ticker: payload.ticker ? String(payload.ticker) : null,
      shares: payload.shares != null ? Number(payload.shares) : null,
      price: payload.averageCost != null ? Number(payload.averageCost) : null,
      amount: null, // ActivityEvent has no cash semantics
      date: e.createdAt.toISOString(),
      description: buildActivityDescription(e.type, payload),
      sourceBroker: null,
    };
  });

  // Post-filter activity by ticker (stored in JSON payload, can't filter in DB)
  // Null-ticker entries are excluded when a ticker filter is present
  if (ticker) {
    activityEntries = activityEntries.filter(
      (e) => e.ticker != null && e.ticker.toUpperCase() === ticker,
    );
  }

  // Map PortfolioTrade → entries (with signed amount)
  const tradeEntries: AccountHistoryEntry[] = portfolioTrades.map((t) => ({
    id: t.id,
    source: 'trade' as const,
    category: getTradeCategory(t.type),
    type: t.type,
    ticker: t.ticker,
    shares: t.shares,
    price: t.price,
    amount: signedTradeAmount(t.type, t.shares, t.price),
    date: t.date.toISOString(),
    description: buildTradeDescription(t.type, t.ticker, t.shares, t.price),
    sourceBroker: t.sourceBroker,
  }));

  // Map LedgerEvent → entries (with signed amount)
  const ledgerEntries: AccountHistoryEntry[] = ledgerEvents.map((le) => ({
    id: le.id,
    source: 'ledger' as const,
    category: getLedgerCategory(le.eventType),
    type: le.eventType,
    ticker: le.ticker,
    shares: le.shares,
    price: le.price,
    amount: signedLedgerAmount(le.eventType, le.amount),
    date: le.effectiveDate.toISOString(),
    description: buildLedgerDescription(le.eventType, le.ticker, le.amount, le.shares),
    sourceBroker: le.sourceBroker,
  }));

  // Merge and sort: date DESC, source priority ASC, id DESC
  let merged = [...activityEntries, ...tradeEntries, ...ledgerEntries];
  merged.sort(compareEntries);

  // Apply composite cursor: skip everything at or before cursor position
  if (parsed) {
    const cursorIdx = merged.findIndex(e => e.source === parsed.source && e.id === parsed.id);
    if (cursorIdx >= 0) {
      merged = merged.slice(cursorIdx + 1);
    } else {
      // Cursor entry not in fetched results; filter by composite comparison
      merged = merged.filter(e => compareEntries(e, {
        date: parsed.date.toISOString(),
        source: parsed.source,
        id: parsed.id,
      }) > 0);
    }
  }

  // Paginate: take limit, detect if more exist
  const hasMore = merged.length > limit;
  const entries = merged.slice(0, limit);
  const nextCursor = hasMore && entries.length > 0
    ? buildCursor(entries[entries.length - 1])
    : null;

  return { entries, nextCursor };
}
