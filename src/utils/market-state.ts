export type MarketState = 'pre_open' | 'intraday' | 'post_close' | 'weekend';

// NYSE full-day closures only. Early-close days (1pm ET, e.g. Black Friday, Christmas Eve,
// July 3rd in years where July 4 is a weekday) are NOT modeled — the brief will use
// intraday voice during the post-bell hours of those ~5 days/year. Acceptable trade-off
// vs. building a half-day calendar. Maintained manually; extend annually.
const NYSE_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents' Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed; July 4 is Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  // 2027
  '2027-01-01', // New Year's Day
  '2027-01-18', // MLK Day
  '2027-02-15', // Presidents' Day
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observed; June 19 is Saturday)
  '2027-07-05', // Independence Day (observed; July 4 is Sunday)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas (observed; Dec 25 is Saturday)
]);

interface ETParts {
  weekday: string;
  hour: number;
  minute: number;
}

function getETParts(date: Date): ETParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  let weekday = '';
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value;
    else if (p.type === 'hour') hour = parseInt(p.value, 10) % 24;
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  return { weekday, hour, minute };
}

export function isNyseHolidayET(date: Date = new Date()): boolean {
  return NYSE_HOLIDAYS.has(getETDateBucket(date));
}

export function getMarketStateET(date: Date = new Date()): MarketState {
  const { weekday, hour, minute } = getETParts(date);
  if (weekday === 'Sat' || weekday === 'Sun') return 'weekend';
  if (isNyseHolidayET(date)) return 'weekend';

  const minutesOfDay = hour * 60 + minute;
  const PRE_OPEN_START = 4 * 60;       // 04:00
  const OPEN_BELL = 9 * 60 + 30;       // 09:30
  const CLOSE_BELL = 16 * 60;          // 16:00

  if (minutesOfDay >= PRE_OPEN_START && minutesOfDay < OPEN_BELL) return 'pre_open';
  if (minutesOfDay >= OPEN_BELL && minutesOfDay < CLOSE_BELL) return 'intraday';
  return 'post_close';
}

export function getETDateBucket(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
