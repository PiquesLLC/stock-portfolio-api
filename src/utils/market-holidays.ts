/**
 * US stock market holidays (NYSE/NASDAQ full closures).
 * Early closes are not included — treated as normal trading days.
 *
 * Source: https://www.nyse.com/markets/hours-calendars
 * Keep updated: add new years as they're announced.
 */
const US_MARKET_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Presidents' Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  // 2027
  '2027-01-01', // New Year's Day
  '2027-01-18', // Martin Luther King Jr. Day
  '2027-02-15', // Presidents' Day
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observed, 19th is Saturday)
  '2027-07-05', // Independence Day (observed)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas (observed, 25th is Saturday)
]);

/**
 * Returns the date as YYYY-MM-DD in America/New_York timezone.
 */
function toETDateString(date: Date): string {
  // en-CA locale gives ISO YYYY-MM-DD format directly.
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Returns true if the given date (interpreted in ET) is a full-closure US market holiday.
 */
export function isUSMarketHoliday(date: Date = new Date()): boolean {
  return US_MARKET_HOLIDAYS.has(toETDateString(date));
}

/**
 * Returns true if the given date (in ET) is a weekday AND not a market holiday.
 */
export function isUSTradingDay(date: Date = new Date()): boolean {
  // ET weekday lookup
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).formatToParts(date);
  const weekday = etParts.find((p) => p.type === 'weekday')?.value;
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return !isUSMarketHoliday(date);
}
