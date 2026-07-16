import prisma from '../utils/prisma';
import { getPriorThresholds, getRegularMarketClose, PriorThresholds } from '../utils/milestone-ranges';
import { getMarketSession, getMarketSessionForTicker } from '../utils/market-hours';
import { etDate, etMidnightUtc } from '../utils/date';
import { sendPushToUser, sendNativePushToUser } from './push.service';
import { fetchPrices } from './market.service';
import NodeCache from 'node-cache';

// ============================================================================
// NOTIFICATION RULE for 52-week / all-time highs and lows (Jon, 2026-07-16):
// a user gets AT MOST two notifications per ticker per trading day —
//
//   1. Intraday, the FIRST time the live price beats yesterday's record:
//        "AAPL hit a new all-time high of $332.57"
//   2. After the 4 PM ET close, only if the CLOSING price beat the record:
//        "AAPL closed at an all-time high of $334.00"
//
// Never re-notify because the price kept climbing intraday (no high-water-mark
// re-fires), never send "is at its high" proximity alerts, and suppress the
// redundant 52W notification when the ATH/ATL counterpart fires the same day
// (an all-time high IS a 52-week high). Records are measured against
// thresholds that EXCLUDE today's bar, so "new" is strict — merely touching
// yesterday's high does not qualify.
// ============================================================================

// Day-scoped in-memory guard (ticker-userId-type-etDay). hasEventTodayET() is
// the source of truth (survives restarts); this cache only avoids re-querying
// on every 30-min cycle. Auto-evicts entries after 24h.
const recentNotifications = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 600 });

interface TickerHolders {
  ticker: string;
  userIds: string[];
}

interface MilestoneDef {
  type: string;
  kind: 'high' | 'low';
  threshold: (t: PriorThresholds) => number | null;
  /** eventType that makes this one redundant when it already fired today */
  suppressedBy?: string;
  /**
   * Reverse guard for ATH/ATL: if the 52W counterpart already fired today AND
   * the two records coincide (the 52-week high IS the all-time high), that
   * alert already announced this exact cross — it only went out as "52-week"
   * because a transient weekly-fetch failure hid the all-time threshold that
   * cycle. Don't announce the same cross a second time.
   */
  redundantAfter?: { type: string; recordsCoincide: (t: PriorThresholds) => boolean };
  message: (ticker: string, price: string) => string;
}

const highsCoincide = (t: PriorThresholds) =>
  t.week52High !== null && t.allTimeHigh !== null && t.week52High >= t.allTimeHigh;
const lowsCoincide = (t: PriorThresholds) =>
  t.week52Low !== null && t.allTimeLow !== null && t.week52Low <= t.allTimeLow;

// Order matters: ATH/ATL are evaluated first so they can suppress the
// redundant 52W counterpart in the same cycle.
const INTRADAY_MILESTONES: MilestoneDef[] = [
  { type: 'ath', kind: 'high', threshold: t => t.allTimeHigh, redundantAfter: { type: '52w_high', recordsCoincide: highsCoincide }, message: (tk, p) => `${tk} hit a new all-time high of $${p}` },
  { type: 'atl', kind: 'low', threshold: t => t.allTimeLow, redundantAfter: { type: '52w_low', recordsCoincide: lowsCoincide }, message: (tk, p) => `${tk} hit a new all-time low of $${p}` },
  { type: '52w_high', kind: 'high', threshold: t => t.week52High, suppressedBy: 'ath', message: (tk, p) => `${tk} hit a new 52-week high of $${p}` },
  { type: '52w_low', kind: 'low', threshold: t => t.week52Low, suppressedBy: 'atl', message: (tk, p) => `${tk} hit a new 52-week low of $${p}` },
];

const CLOSE_MILESTONES: MilestoneDef[] = [
  { type: 'ath_close', kind: 'high', threshold: t => t.allTimeHigh, redundantAfter: { type: '52w_high_close', recordsCoincide: highsCoincide }, message: (tk, p) => `${tk} closed at an all-time high of $${p}` },
  { type: 'atl_close', kind: 'low', threshold: t => t.allTimeLow, redundantAfter: { type: '52w_low_close', recordsCoincide: lowsCoincide }, message: (tk, p) => `${tk} closed at an all-time low of $${p}` },
  { type: '52w_high_close', kind: 'high', threshold: t => t.week52High, suppressedBy: 'ath_close', message: (tk, p) => `${tk} closed at a 52-week high of $${p}` },
  { type: '52w_low_close', kind: 'low', threshold: t => t.week52Low, suppressedBy: 'atl_close', message: (tk, p) => `${tk} closed at a 52-week low of $${p}` },
];

function isWeekendET(now: Date): boolean {
  const etDay = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return etDay === 'Sat' || etDay === 'Sun';
}

/** All held tickers with the users who hold them */
async function getTickerHolders(): Promise<TickerHolders[]> {
  const holdings = await prisma.holding.findMany({
    where: {
      shares: { gt: 0 },
    },
    select: {
      ticker: true,
      userId: true,
    },
  });

  const tickerHoldersMap = new Map<string, Set<string>>();
  for (const holding of holdings) {
    if (!holding.userId) continue;
    const ticker = holding.ticker.toUpperCase();
    if (!tickerHoldersMap.has(ticker)) {
      tickerHoldersMap.set(ticker, new Set());
    }
    tickerHoldersMap.get(ticker)!.add(holding.userId);
  }

  return Array.from(tickerHoldersMap.entries()).map(
    ([ticker, userIds]) => ({ ticker, userIds: Array.from(userIds) })
  );
}

/** True if this user already got this milestone type for this ticker today (ET) */
async function hasEventTodayET(userId: string, ticker: string, eventType: string, now: Date): Promise<boolean> {
  const existing = await prisma.milestoneEvent.findFirst({
    where: {
      userId,
      ticker,
      eventType,
      createdAt: { gte: etMidnightUtc(now) },
    },
    select: { id: true },
  });
  return existing !== null;
}

/**
 * Run the milestone definitions for one ticker at one price, creating at most
 * one event per user+type per ET day.
 */
async function evaluateMilestonesForTicker(opts: {
  ticker: string;
  userIds: string[];
  price: number;
  thresholds: PriorThresholds;
  defs: MilestoneDef[];
  now: Date;
}): Promise<void> {
  const { ticker, userIds, price, thresholds, defs, now } = opts;
  const today = etDate(now);
  // Types that fired for a user in THIS evaluation, so 52W can be suppressed
  // without waiting for the DB write to become visible
  const firedThisCycle = new Set<string>();

  for (const def of defs) {
    const threshold = def.threshold(thresholds);
    if (threshold === null || threshold <= 0) continue;

    const crossed = def.kind === 'high' ? price > threshold : price < threshold;
    if (!crossed) continue;

    for (const userId of userIds) {
      const dayKey = `${ticker}-${userId}-${def.type}-${today}`;
      if (recentNotifications.get(dayKey)) continue;

      // ATH/ATL implies the 52W counterpart — one notification is enough
      if (def.suppressedBy) {
        if (firedThisCycle.has(`${userId}:${def.suppressedBy}`)) continue;
        if (await hasEventTodayET(userId, ticker, def.suppressedBy, now)) continue;
      }

      // ...and when the records coincide, a 52W alert that already went out
      // today covers this same cross — don't re-announce it as ATH/ATL
      if (def.redundantAfter && def.redundantAfter.recordsCoincide(thresholds)) {
        if (await hasEventTodayET(userId, ticker, def.redundantAfter.type, now)) continue;
      }

      // Once per ET day (source of truth — survives restarts)
      if (await hasEventTodayET(userId, ticker, def.type, now)) {
        recentNotifications.set(dayKey, true);
        continue;
      }

      const message = def.message(ticker, price.toFixed(2));

      await prisma.milestoneEvent.create({
        data: {
          userId,
          ticker,
          eventType: def.type,
          message,
          currentPrice: price,
          thresholdPrice: threshold,
          isNewRecord: true,
        },
      });

      // Fire-and-forget push notification (web + native)
      const milestonePushPayload = {
        title: `Milestone: ${ticker}`,
        body: message,
        tag: `milestone-${ticker}-${def.type}`,
        data: { type: 'milestone', url: '/' },
      };
      sendPushToUser(userId, milestonePushPayload).catch(() => {});
      sendNativePushToUser(userId, milestonePushPayload).catch(() => {});

      recentNotifications.set(dayKey, true);
      firedThisCycle.add(`${userId}:${def.type}`);

      console.log(`[Milestone] ${message}`);
    }
  }
}

/**
 * Intraday check across all holdings: fires the "hit a new ..." notification
 * the first time a ticker's live regular-session price beats yesterday's
 * record. At most one per ticker+user+type per ET day.
 */
export async function checkMilestoneAlerts(): Promise<void> {
  const now = new Date();

  // Weekend prices are stale Friday closes, not real milestones
  if (isWeekendET(now)) {
    console.log('[Milestone] Skipping — market closed (weekend)');
    return;
  }

  console.log('[Milestone] Starting automatic check for all holdings...');

  try {
    const tickerHolders = await getTickerHolders();
    if (tickerHolders.length === 0) {
      console.log('[Milestone] No holdings found');
      return;
    }

    console.log(`[Milestone] Checking ${tickerHolders.length} tickers`);

    const allTickers = tickerHolders.map(t => t.ticker);
    const { quotes } = await fetchPrices(allTickers);

    for (const { ticker, userIds } of tickerHolders) {
      // Only regular-session prints count as official highs/lows — thin
      // pre/post-market spikes never enter the daily bars these records are
      // measured against. (24/7 assets like crypto are always REG.)
      if (getMarketSessionForTicker(ticker, now) !== 'REG') continue;

      const quote = quotes.get(ticker);
      if (!quote || quote.currentPrice <= 0) continue;

      const thresholds = await getPriorThresholds(ticker, now);
      if (!thresholds) continue;

      await evaluateMilestonesForTicker({
        ticker,
        userIds,
        price: quote.currentPrice,
        thresholds,
        defs: INTRADAY_MILESTONES,
        now,
      });

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log('[Milestone] Check complete');
  } catch (err) {
    console.error('[Milestone] Error:', err);
    throw err;
  }
}

/**
 * End-of-day check: fires "closed at ..." when the official regular-session
 * closing price itself beat yesterday's record. Runs once per trading day
 * shortly after the 4 PM ET close (scheduled + idempotency-keyed in index.ts;
 * the per-day event dedup here makes re-runs harmless).
 */
export async function checkMilestoneCloseAlerts(): Promise<void> {
  const now = new Date();

  if (isWeekendET(now)) return;

  const session = getMarketSession(now);
  if (session === 'PRE' || session === 'REG') {
    console.log('[Milestone Close] Skipping — market has not closed yet');
    return;
  }

  console.log('[Milestone Close] Starting end-of-day check for all holdings...');

  try {
    const tickerHolders = await getTickerHolders();
    if (tickerHolders.length === 0) {
      console.log('[Milestone Close] No holdings found');
      return;
    }

    const today = etDate(now);

    for (const { ticker, userIds } of tickerHolders) {
      // Assets that never close (crypto, futures) have no closing print
      if (getMarketSessionForTicker(ticker, now) === 'REG') continue;

      const regularClose = await getRegularMarketClose(ticker, now);
      // closedOnEtDate mismatch = holiday or stale data — not today's close
      if (!regularClose || regularClose.closedOnEtDate !== today) continue;

      const thresholds = await getPriorThresholds(ticker, now);
      if (!thresholds) continue;

      await evaluateMilestonesForTicker({
        ticker,
        userIds,
        price: regularClose.close,
        thresholds,
        defs: CLOSE_MILESTONES,
        now,
      });

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log('[Milestone Close] Check complete');
  } catch (err) {
    console.error('[Milestone Close] Error:', err);
    throw err;
  }
}

/**
 * Get milestone events for a user
 */
export async function getMilestoneEvents(userId: string, limit = 50): Promise<any[]> {
  return prisma.milestoneEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/**
 * Get unread milestone event count for a user
 */
export async function getUnreadMilestoneCount(userId: string): Promise<number> {
  return prisma.milestoneEvent.count({
    where: { userId, read: false },
  });
}

/**
 * Mark a milestone event as read (with ownership verification)
 */
export async function markMilestoneEventRead(eventId: string, userId: string): Promise<boolean> {
  const event = await prisma.milestoneEvent.findFirst({
    where: { id: eventId, userId },
  });
  if (!event) return false;
  await prisma.milestoneEvent.update({
    where: { id: eventId },
    data: { read: true },
  });
  return true;
}

/**
 * Mark all milestone events as read for a user
 */
export async function markAllMilestoneEventsRead(userId: string): Promise<void> {
  await prisma.milestoneEvent.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
}
