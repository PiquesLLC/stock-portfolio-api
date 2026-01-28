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
