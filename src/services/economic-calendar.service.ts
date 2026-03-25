import axios from 'axios';
import NodeCache from 'node-cache';

const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

export interface EconomicCalendarEvent {
  event: string;
  date: string;
  time: string;
  country: string;
  impact: 'high' | 'medium' | 'low';
  actual?: number;
  estimate?: number;
  previous?: number;
}

// Key events we care about most — shown with higher priority
const HIGH_PRIORITY_KEYWORDS = [
  'FOMC', 'Federal Funds Rate', 'Interest Rate Decision',
  'CPI', 'Consumer Price Index',
  'GDP', 'Gross Domestic Product',
  'Nonfarm Payrolls', 'NFP', 'Employment',
  'Unemployment', 'Initial Jobless Claims',
  'PPI', 'Producer Price Index',
  'PCE', 'Personal Consumption',
  'ISM Manufacturing', 'ISM Services', 'PMI',
  'Retail Sales',
  'Housing Starts', 'Building Permits',
  'Consumer Confidence', 'Michigan Consumer',
  'Durable Goods',
];

function classifyImpact(event: string, sourceImpact?: string): 'high' | 'medium' | 'low' {
  const normalized = sourceImpact?.toLowerCase();
  if (normalized === 'high') return 'high';
  const upper = event.toUpperCase();
  if (HIGH_PRIORITY_KEYWORDS.some(kw => upper.includes(kw.toUpperCase()))) return 'high';
  if (normalized === 'medium') return 'medium';
  return 'low';
}

function parseFloat_(v: string | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

/** Primary source: ForexFactory free JSON feed (no API key required) */
async function fetchFromForexFactory(): Promise<EconomicCalendarEvent[]> {
  const resp = await axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
    timeout: 10000,
  });

  const events: any[] = resp.data;
  if (!Array.isArray(events)) return [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return events
    .filter((e: any) => e.country === 'USD')
    .map((e: any) => {
      const dt = e.date ? new Date(e.date) : null;
      const dateStr = dt ? dt.toISOString().split('T')[0] : '';
      const timeStr = dt
        ? dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' })
        : '';

      return {
        event: e.title || 'Unknown Event',
        date: dateStr,
        time: timeStr,
        country: 'US',
        impact: classifyImpact(e.title || '', e.impact),
        actual: parseFloat_(e.actual),
        estimate: parseFloat_(e.forecast),
        previous: parseFloat_(e.previous),
      };
    })
    .filter((e: EconomicCalendarEvent) => {
      // Only future or today events, high/medium impact
      if (e.impact === 'low') return false;
      if (!e.date) return false;
      const eventDate = new Date(e.date + 'T23:59:59');
      return eventDate >= today;
    })
    .sort((a: EconomicCalendarEvent, b: EconomicCalendarEvent) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return a.impact === 'high' ? -1 : 1;
    })
    .slice(0, 20);
}

export async function getUpcomingEconomicEvents(): Promise<EconomicCalendarEvent[]> {
  const cached = cache.get<EconomicCalendarEvent[]>('economic-calendar');
  if (cached) return cached;

  try {
    const events = await fetchFromForexFactory();
    if (events.length > 0) {
      cache.set('economic-calendar', events);
      return events;
    }
  } catch (err) {
    console.warn('[Economic Calendar] ForexFactory fetch failed:', (err as Error).message);
  }

  return [];
}
