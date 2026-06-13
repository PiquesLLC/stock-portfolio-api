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
