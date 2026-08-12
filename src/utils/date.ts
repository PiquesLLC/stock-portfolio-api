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

const _etHourMinuteFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Minutes since ET midnight (0–1439) — market-clock math that never picks up
 *  server-local time (UTC on Railway). Reads the formatter's parts rather than
 *  splitting its string: a locale that inserts a day period or a narrow no-break
 *  space would otherwise yield NaN, and NaN silently fails every `>=` comparison
 *  a caller makes against it. */
export function etMinutesOfDay(d: Date = new Date()): number {
  const parts = _etHourMinuteFmt.formatToParts(d);
  const hours = Number(parts.find(p => p.type === 'hour')?.value);
  const minutes = Number(parts.find(p => p.type === 'minute')?.value);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    throw new Error(`etMinutesOfDay: unparseable ET time "${_etHourMinuteFmt.format(d)}"`);
  }
  return hours * 60 + minutes;
}

/** Noon UTC on an ET calendar day — an unambiguous anchor for day arithmetic in
 *  any timezone within ±11 hours, so DST never enters the calculation. */
function etDayAnchor(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`Expected an ET calendar day as YYYY-MM-DD, got "${day}"`);
  }
  return new Date(`${day}T12:00:00Z`);
}

/** The ET calendar day before `day` (both YYYY-MM-DD). */
export function previousEtDay(day: string): string {
  const anchor = etDayAnchor(day);
  anchor.setUTCDate(anchor.getUTCDate() - 1);
  return anchor.toISOString().slice(0, 10);
}

/** True when an ET calendar day (YYYY-MM-DD) is a Saturday or Sunday. */
export function isEtWeekend(day: string): boolean {
  const weekday = etDayAnchor(day).getUTCDay();
  return weekday === 0 || weekday === 6;
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
