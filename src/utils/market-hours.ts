import { MarketSession } from '../types';

/**
 * Determines the current market session based on NYSE/Nasdaq hours.
 * All times are in America/New_York timezone.
 *
 * PRE:    4:00 AM - 9:30 AM ET (Pre-market)
 * REG:    9:30 AM - 4:00 PM ET (Regular session)
 * POST:   4:00 PM - 8:00 PM ET (After-hours)
 * CLOSED: 8:00 PM - 4:00 AM ET (Market closed)
 *
 * Note: This doesn't account for holidays or early closes.
 */
export function getMarketSession(date: Date = new Date()): MarketSession {
  // Convert to ET (Eastern Time)
  const etTime = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = etTime.getDay(); // 0 = Sunday, 6 = Saturday
  const hours = etTime.getHours();
  const minutes = etTime.getMinutes();
  const timeInMinutes = hours * 60 + minutes;

  // Weekend = CLOSED
  if (day === 0 || day === 6) {
    return 'CLOSED';
  }

  // Time boundaries in minutes from midnight
  const PRE_START = 4 * 60;        // 4:00 AM = 240
  const REG_START = 9 * 60 + 30;   // 9:30 AM = 570
  const REG_END = 16 * 60;         // 4:00 PM = 960
  const POST_END = 20 * 60;        // 8:00 PM = 1200

  if (timeInMinutes < PRE_START) {
    return 'CLOSED';
  } else if (timeInMinutes < REG_START) {
    return 'PRE';
  } else if (timeInMinutes < REG_END) {
    return 'REG';
  } else if (timeInMinutes < POST_END) {
    return 'POST';
  } else {
    return 'CLOSED';
  }
}

/**
 * True if `createdAt` falls on the current calendar day in US market time (ET).
 *
 * Used to anchor a position's day P&L at its cost basis when it was opened
 * today: the holder did not own it at yesterday's close, so anchoring the
 * day change at previousClose counts a full-day move the user never
 * experienced (a position only ever up could show a red "today" loss).
 *
 * Note: keyed on the aggregated Holding row's createdAt (when the position was
 * first opened), so adding shares intraday to a position opened on a prior day
 * is NOT reclassified as "opened today" — those added shares stay anchored at
 * previousClose. Per-lot accuracy would require the trade ledger, which the
 * valuation path intentionally does not load.
 */
export function isOpenedTodayET(createdAt: Date, now: Date = new Date()): boolean {
  // Defensive: a missing/invalid createdAt must not crash valuation — fall back
  // to "not today" so the day-P&L anchor stays at previousClose.
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) return false;
  const etDate = (d: Date) => d.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  return etDate(createdAt) === etDate(now);
}

/**
 * Returns a human-readable label for the session
 */
export function getSessionLabel(session: MarketSession): string {
  switch (session) {
    case 'PRE': return 'Pre-Market';
    case 'REG': return 'Regular';
    case 'POST': return 'After-Hours';
    case 'CLOSED': return 'Closed';
  }
}

/**
 * Returns a short label for display badges
 */
export function getSessionBadge(session: MarketSession): string {
  switch (session) {
    case 'PRE': return 'PRE';
    case 'REG': return 'REG';
    case 'POST': return 'AH';
    case 'CLOSED': return 'CLOSED';
  }
}

/**
 * Checks if the market is currently in extended hours (pre or post)
 */
export function isExtendedHours(session?: MarketSession): boolean {
  return session === 'PRE' || session === 'POST';
}

/**
 * Get time in minutes from midnight for a given timezone
 */
function getTimeInMinutes(date: Date, timezone: string): { timeInMinutes: number; day: number } {
  const localized = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  return {
    timeInMinutes: localized.getHours() * 60 + localized.getMinutes(),
    day: localized.getDay(),
  };
}

// Sunday 19:00 ET — the weekly instant where every Mon–Fri market THIS FILE
// MODELS is shut while crypto and commodity futures are open. A fixed instant
// answers "does this ticker trade on weekends?" the same way whenever it is
// asked; probing "now" gets it wrong every Monday morning.
//
// Margins, so a later edit doesn't silently break the classification: futures
// reopened an hour earlier (18:00 ET), and Tokyo (08:00 JST), Hong Kong (07:00
// HKT) and Sydney (09:00 AEST) are each an hour or more from Monday's open.
// A settled past Sunday, so no future tzdata revision can move it.
const WEEKEND_SESSION_PROBE = new Date('2025-08-17T23:00:00Z');

/**
 * True when the ticker's market runs through the weekend (crypto, commodity
 * futures) rather than Monday–Friday. Such a market has no "previous session"
 * to fall back on: the current day is always the one that should have data.
 */
export function tradesOnWeekends(ticker: string): boolean {
  return getMarketSessionForTicker(ticker, WEEKEND_SESSION_PROBE) !== 'CLOSED';
}

/** Suffixes whose entire session fits inside one ET calendar day: Toronto and
 *  TSX Venture share ET, London/Euronext/Xetra all close before noon ET, and the
 *  US class-share / unit / warrant suffixes are US-session symbols that merely
 *  happen to carry a dot (BRK.B). No Yahoo exchange suffix collides with those. */
const ET_CALENDAR_DAY_SUFFIXES = [
  '.TO', '.V',                                     // Toronto, TSX Venture
  '.L', '.PA', '.AS', '.DE', '.MI', '.MC', '.BR',  // London, Euronext, Xetra
  '.A', '.B', '.C', '.U', '.W', '.WS',             // US classes, units, warrants
];

/** Quote currencies that mark a 24/7 crypto pair — the same list
 *  `getMarketSessionForTicker` uses, so the two agree on what a hyphen means. */
const CRYPTO_QUOTE_SUFFIXES = ['-USD', '-CAD', '-EUR', '-GBP'];

/**
 * True when the ticker's entire trading day falls inside one ET calendar day —
 * the assumption behind any "one session = one ET date" filter.
 *
 * An allowlist, deliberately: unrecognized suffixes answer `false`, so the
 * filter fails safe. Leaving a US series untrimmed is harmless, while trimming
 * a session that opens the previous evening in ET silently lops off its opening
 * hours — Tokyo 09:00 JST is 20:00 ET the day before, and the same holds for
 * Seoul, Taipei, Shanghai, Singapore and Auckland, none of which
 * `getMarketSessionForTicker` models but all of which symbol search can return.
 */
export function tradesWithinEtCalendarDay(ticker: string): boolean {
  const upper = ticker.toUpperCase();
  // Commodity futures (GC=F) and crypto pairs (BTC-USD) run around the clock.
  // Match crypto on the quote currency, not on any hyphen — BRK-B is a US
  // class share, and calling it a 24/7 market costs it the ET-day filter.
  if (upper.includes('=')) return false;
  if (CRYPTO_QUOTE_SUFFIXES.some(suffix => upper.endsWith(suffix))) return false;
  const suffixStart = upper.lastIndexOf('.');
  if (suffixStart === -1) return true; // plain US symbol
  return ET_CALENDAR_DAY_SUFFIXES.includes(upper.slice(suffixStart));
}

/**
 * Determines market session for a specific ticker, accounting for international markets and commodities.
 */
export function getMarketSessionForTicker(ticker: string, date: Date = new Date()): MarketSession {
  const upper = ticker.toUpperCase();

  // Crypto trades 24/7
  if (upper.endsWith('-USD') || upper.endsWith('-CAD') || upper.endsWith('-EUR') || upper.endsWith('-GBP')) {
    return 'REG';
  }

  // Commodity futures trade nearly 24/7 on weekdays (Sun evening through Fri afternoon)
  if (upper.includes('=F')) {
    const { day } = getTimeInMinutes(date, 'America/New_York');
    // Closed Saturday and most of Sunday (opens Sunday 6pm ET)
    if (day === 6) return 'CLOSED';
    if (day === 0) {
      const { timeInMinutes } = getTimeInMinutes(date, 'America/New_York');
      return timeInMinutes >= 18 * 60 ? 'REG' : 'CLOSED';
    }
    return 'REG';
  }

  // Canadian stocks (.TO, .V)
  if (upper.endsWith('.TO') || upper.endsWith('.V')) {
    const { timeInMinutes, day } = getTimeInMinutes(date, 'America/New_York');
    if (day === 0 || day === 6) return 'CLOSED';
    // TSX: 9:30 AM - 4:00 PM ET (same timezone, no official extended hours)
    if (timeInMinutes >= 570 && timeInMinutes < 960) return 'REG';
    return 'CLOSED';
  }

  // London (.L)
  if (upper.endsWith('.L')) {
    const { timeInMinutes, day } = getTimeInMinutes(date, 'Europe/London');
    if (day === 0 || day === 6) return 'CLOSED';
    // LSE: 8:00 AM - 4:30 PM GMT
    if (timeInMinutes >= 480 && timeInMinutes < 990) return 'REG';
    return 'CLOSED';
  }

  // European (.PA, .AS, .DE, .MI, .MC, .BR)
  if (/\.(PA|AS|DE|MI|MC|BR)$/.test(upper)) {
    const { timeInMinutes, day } = getTimeInMinutes(date, 'Europe/Paris');
    if (day === 0 || day === 6) return 'CLOSED';
    // Euronext/Xetra: 9:00 AM - 5:30 PM CET
    if (timeInMinutes >= 540 && timeInMinutes < 1050) return 'REG';
    return 'CLOSED';
  }

  // Tokyo (.T)
  if (upper.endsWith('.T')) {
    const { timeInMinutes, day } = getTimeInMinutes(date, 'Asia/Tokyo');
    if (day === 0 || day === 6) return 'CLOSED';
    // TSE: 9:00 AM - 3:00 PM JST (with lunch break 11:30-12:30, simplified to REG)
    if (timeInMinutes >= 540 && timeInMinutes < 900) return 'REG';
    return 'CLOSED';
  }

  // Hong Kong (.HK)
  if (upper.endsWith('.HK')) {
    const { timeInMinutes, day } = getTimeInMinutes(date, 'Asia/Hong_Kong');
    if (day === 0 || day === 6) return 'CLOSED';
    // HKEX: 9:30 AM - 4:00 PM HKT
    if (timeInMinutes >= 570 && timeInMinutes < 960) return 'REG';
    return 'CLOSED';
  }

  // Australian (.AX)
  if (upper.endsWith('.AX')) {
    const { timeInMinutes, day } = getTimeInMinutes(date, 'Australia/Sydney');
    if (day === 0 || day === 6) return 'CLOSED';
    // ASX: 10:00 AM - 4:00 PM AEST
    if (timeInMinutes >= 600 && timeInMinutes < 960) return 'REG';
    return 'CLOSED';
  }

  // Default: US market hours
  return getMarketSession(date);
}
