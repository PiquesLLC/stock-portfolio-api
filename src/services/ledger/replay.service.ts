import prisma from '../../utils/prisma';
import {
  LEDGER_SETTLEMENT_POLICY,
  TRADE_SETTLEMENT_POLICY,
  type LedgerEventType,
  type TradeEventType,
  isValidLedgerEventType,
} from './settlement-policy';

export type ReplayPosition = { shares: number; costBasis: number };

export type DailyLedgerSnapshot = {
  date: Date;
  positions: Map<string, ReplayPosition>;
  cash: number;
  margin: number;
  equity: number;
};

type PositionPosting = {
  atMs: number;
  rowIndex: number;
  seq: number;
  type: 'trade' | 'ledger';
  eventType: string;
  ticker: string;
  shares: number;
  price: number;
};

type CashPosting = {
  atMs: number;
  rowIndex: number;
  seq: number;
  deltaCash: number;
  deltaMargin: number;
};

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function endOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

function clonePositions(source: Map<string, ReplayPosition>): Map<string, ReplayPosition> {
  const out = new Map<string, ReplayPosition>();
  for (const [ticker, pos] of source) {
    out.set(ticker, { shares: pos.shares, costBasis: pos.costBasis });
  }
  return out;
}

function sumCostBasis(positions: Map<string, ReplayPosition>): number {
  let total = 0;
  for (const pos of positions.values()) total += pos.costBasis;
  return total;
}

function toTradeType(value: string): TradeEventType | null {
  const t = value.toLowerCase();
  if (t === 'buy' || t === 'sell' || t === 'split' || t === 'transfer' || t === 'merger' || t === 'cancel') {
    return t;
  }
  return null;
}

/**
 * Replay PortfolioTrade + LedgerEvent history into daily account-state snapshots.
 *
 * Notes:
 * - Settlement-aware: trade cash posts at settle date (fallback T+1 calendar day when settleDate is unavailable).
 * - Equity here is book-value based: cash - margin + total position cost basis.
 *   Price-marking happens in chart valuation code.
 */
export async function replayDailyLedger(
  userId: string,
  startDate: Date,
  endDate: Date,
): Promise<DailyLedgerSnapshot[]> {
  const rangeStart = startOfUtcDay(startDate);
  const rangeEnd = endOfUtcDay(endDate);

  if (rangeEnd.getTime() < rangeStart.getTime()) return [];

  const [trades, ledgerEvents] = await Promise.all([
    prisma.portfolioTrade.findMany({
      where: {
        userId,
        date: { lte: rangeEnd },
      },
      orderBy: [{ date: 'asc' }, { rowIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { date: true, ticker: true, type: true, shares: true, price: true, rowIndex: true },
    }),
    prisma.ledgerEvent.findMany({
      where: {
        userId,
        effectiveDate: { lte: rangeEnd },
      },
      orderBy: [{ effectiveDate: 'asc' }, { rowIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        eventType: true,
        effectiveDate: true,
        settleDate: true,
        ticker: true,
        shares: true,
        price: true,
        amount: true,
        rowIndex: true,
      },
    }),
  ]);

  const positionPostings: PositionPosting[] = [];
  const cashPostings: CashPosting[] = [];
  let seq = 0;

  for (const t of trades) {
    const tradeType = toTradeType(t.type);
    if (!tradeType) continue;

    const effectiveMs = t.date.getTime();
    const settleMs =
      TRADE_SETTLEMENT_POLICY[tradeType].cashPosting === 'settleDate'
        ? addUtcDays(startOfUtcDay(t.date), 1).getTime()
        : effectiveMs;

    if (TRADE_SETTLEMENT_POLICY[tradeType].positionPosting !== 'none') {
      positionPostings.push({
        atMs: effectiveMs,
        rowIndex: t.rowIndex ?? 0,
        seq: seq++,
        type: 'trade',
        eventType: tradeType,
        ticker: t.ticker,
        shares: Math.abs(t.shares || 0),
        price: Math.abs(t.price || 0),
      });
    }

    if (TRADE_SETTLEMENT_POLICY[tradeType].cashPosting !== 'none') {
      let deltaCash = 0;
      const notional = Math.abs((t.shares || 0) * (t.price || 0));
      if (tradeType === 'buy') deltaCash = -notional;
      else if (tradeType === 'sell' || tradeType === 'cancel') deltaCash = notional;

      if (deltaCash !== 0) {
        cashPostings.push({
          atMs: settleMs,
          rowIndex: t.rowIndex ?? 0,
          seq: seq++,
          deltaCash,
          deltaMargin: 0,
        });
      }
    }
  }

  for (const e of ledgerEvents) {
    if (!isValidLedgerEventType(e.eventType)) continue;
    const eventType = e.eventType as LedgerEventType;
    const policy = LEDGER_SETTLEMENT_POLICY[eventType];
    const effectiveMs = e.effectiveDate.getTime();
    const settleMs = e.settleDate ? e.settleDate.getTime() : effectiveMs;

    if (policy.positionPosting !== 'none') {
      if (eventType === 'DIV_REINVEST' && e.ticker && (e.shares || 0) > 0) {
        positionPostings.push({
          atMs: policy.positionPosting === 'settleDate' ? settleMs : effectiveMs,
          rowIndex: e.rowIndex ?? 0,
          seq: seq++,
          type: 'ledger',
          eventType,
          ticker: e.ticker,
          shares: Math.abs(e.shares || 0),
          price: Math.abs(e.price || 0),
        });
      }
    }

    if (policy.cashPosting !== 'none') {
      const cashAtMs = policy.cashPosting === 'settleDate' ? settleMs : effectiveMs;
      let deltaMargin = 0;
      if (eventType === 'MARGIN_BORROW') deltaMargin = Math.abs(e.amount || 0);
      if (eventType === 'MARGIN_REPAY') deltaMargin = -Math.abs(e.amount || 0);

      cashPostings.push({
        atMs: cashAtMs,
        rowIndex: e.rowIndex ?? 0,
        seq: seq++,
        deltaCash: e.amount || 0,
        deltaMargin,
      });
    }
  }

  positionPostings.sort((a, b) => (a.atMs - b.atMs) || (a.rowIndex - b.rowIndex) || (a.seq - b.seq));
  cashPostings.sort((a, b) => (a.atMs - b.atMs) || (a.rowIndex - b.rowIndex) || (a.seq - b.seq));

  const positions = new Map<string, ReplayPosition>();
  let cash = 0;
  let margin = 0;
  let pIdx = 0;
  let cIdx = 0;

  const snapshots: DailyLedgerSnapshot[] = [];
  for (let day = new Date(rangeStart); day.getTime() <= rangeEnd.getTime(); day = addUtcDays(day, 1)) {
    const dayEndMs = endOfUtcDay(day).getTime();

    while (pIdx < positionPostings.length && positionPostings[pIdx].atMs <= dayEndMs) {
      const posting = positionPostings[pIdx++];
      const current = positions.get(posting.ticker) || { shares: 0, costBasis: 0 };

      if (posting.type === 'trade') {
        if (posting.eventType === 'buy' || posting.eventType === 'transfer' || posting.eventType === 'merger') {
          current.shares += posting.shares;
          current.costBasis += posting.shares * posting.price;
          positions.set(posting.ticker, current);
        } else if (posting.eventType === 'sell' || posting.eventType === 'cancel') {
          if (current.shares <= 0) {
            positions.delete(posting.ticker);
          } else {
            const avg = current.costBasis / current.shares;
            current.shares -= posting.shares;
            if (current.shares <= 0.000001) {
              positions.delete(posting.ticker);
            } else {
              current.costBasis = current.shares * avg;
              positions.set(posting.ticker, current);
            }
          }
        } else if (posting.eventType === 'split') {
          if (current.shares > 0) {
            current.shares += posting.shares;
            positions.set(posting.ticker, current);
          }
        }
      } else if (posting.type === 'ledger' && posting.eventType === 'DIV_REINVEST') {
        current.shares += posting.shares;
        if (posting.price > 0) {
          current.costBasis += posting.shares * posting.price;
        }
        positions.set(posting.ticker, current);
      }
    }

    while (cIdx < cashPostings.length && cashPostings[cIdx].atMs <= dayEndMs) {
      const posting = cashPostings[cIdx++];
      cash += posting.deltaCash;
      margin += posting.deltaMargin;
      if (margin < 0) margin = 0;
    }

    const clonedPositions = clonePositions(positions);
    const equity = cash - margin + sumCostBasis(clonedPositions);
    snapshots.push({
      date: new Date(dayEndMs),
      positions: clonedPositions,
      cash,
      margin,
      equity,
    });
  }

  return snapshots;
}

