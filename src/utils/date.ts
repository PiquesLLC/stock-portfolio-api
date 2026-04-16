const _etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/** YYYY-MM-DD in America/New_York — use instead of toISOString().split('T')[0]
 *  whenever the date must match the US market calendar (after 8 PM ET, UTC
 *  has already rolled over to "tomorrow" and returning that breaks Polygon/
 *  Yahoo candle ranges, cache keys, and any other market-day logic). */
export function etDate(d: Date = new Date()): string {
  return _etFmt.format(d);
}
