const _etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const _etHourFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** YYYY-MM-DD in America/New_York — use instead of toISOString().split('T')[0]
 *  whenever the date must match the US market calendar (after 8 PM ET, UTC
 *  has already rolled over to "tomorrow" and returning that breaks Polygon/
 *  Yahoo candle ranges, cache keys, and any other market-day logic). */
export function etDate(d: Date = new Date()): string {
  return _etFmt.format(d);
}

/** "YYYY-MM-DD HH" in America/New_York — hourly bucket key aligned to the
 *  market calendar (UTC-hour bucketing splits the same ET evening across two
 *  "days" once the clock passes 8 PM ET). */
export function etDateHour(d: Date = new Date()): string {
  return `${etDate(d)} ${_etHourFmt.format(d)}`;
}

/** The UTC instant of ET midnight for the ET calendar day containing `d`.
 *  DST-safe: ET is either -05:00 (EST) or -04:00 (EDT); try both and keep the
 *  one that actually renders as 00:xx ET on the same ET day. ET midnight always
 *  exists — DST transitions happen at 2 AM. Use this instead of
 *  `setHours(0,0,0,0)`, which yields SERVER-LOCAL midnight (UTC on Railway —
 *  ~8 PM ET the previous evening). */
export function etMidnightUtc(d: Date = new Date()): Date {
  const day = etDate(d);
  for (const offset of ['-05:00', '-04:00']) {
    const candidate = new Date(`${day}T00:00:00${offset}`);
    if (etDate(candidate) === day && _etHourFmt.format(candidate) === '00') {
      return candidate;
    }
  }
  // Unreachable for America/New_York, but never return an unchecked value.
  return new Date(`${day}T00:00:00-05:00`);
}
