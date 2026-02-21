/**
 * Calendar Service — generates iCal (.ics) files for dividend events.
 * RFC 5545 compliant VCALENDAR with VEVENT entries.
 */

import prisma from '../utils/prisma';
import { getUpcomingDividendEvents } from './dividend.service';



function formatDateICS(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function formatDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function escapeICS(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export async function generateDividendCalendar(userId: string, options?: {
  months?: number;
  ticker?: string;
}): Promise<string> {
  const months = Math.min(options?.months ?? 6, 24);

  const events = await getUpcomingDividendEvents(userId);

  // Filter by months range
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() + months);
  let filtered = events.filter(e => e.payDate <= cutoff);

  // Filter by ticker if specified
  if (options?.ticker) {
    const upper = options.ticker.toUpperCase();
    filtered = filtered.filter(e => e.ticker === upper);
  }

  // Get user's holdings for payout calculation
  const holdings = await prisma.holding.findMany({
    where: { userId, shares: { gt: 0 } },
    select: { ticker: true, shares: true },
  });
  const sharesMap = new Map(holdings.map(h => [h.ticker, h.shares]));

  const now = new Date();
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nala//Dividend Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Nala Dividends',
  ];

  for (const event of filtered) {
    const shares = sharesMap.get(event.ticker) ?? 0;
    const payout = (event.amountPerShare * shares).toFixed(2);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:dividend-${event.id}@nala-portfolio`);
    lines.push(`DTSTAMP:${formatDateICS(now)}`);
    lines.push(`DTSTART;VALUE=DATE:${formatDateOnly(event.payDate)}`);
    lines.push(`SUMMARY:${escapeICS(event.ticker)} Dividend - $${payout}`);
    lines.push(`DESCRIPTION:${escapeICS([
      `Ticker: ${event.ticker}`,
      `Amount/Share: $${event.amountPerShare.toFixed(4)}`,
      `Shares: ${shares}`,
      `Expected Payout: $${payout}`,
      `Ex-Date: ${event.exDate.toISOString().slice(0, 10)}`,
      `Type: ${event.dividendType}`,
    ].join('\\n'))}`);
    lines.push(`CATEGORIES:Dividend`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
