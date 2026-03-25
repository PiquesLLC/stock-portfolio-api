import axios from 'axios';
import NodeCache from 'node-cache';
import { config } from '../config';

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

function classifyImpact(event: string, finnhubImpact?: string): 'high' | 'medium' | 'low' {
  if (finnhubImpact === 'high') return 'high';
  const upper = event.toUpperCase();
  if (HIGH_PRIORITY_KEYWORDS.some(kw => upper.includes(kw.toUpperCase()))) return 'high';
  if (finnhubImpact === 'medium') return 'medium';
  return 'low';
}

export async function getUpcomingEconomicEvents(): Promise<EconomicCalendarEvent[]> {
  const cached = cache.get<EconomicCalendarEvent[]>('economic-calendar');
  if (cached) return cached;

  if (!config.finnhubApiKey) return [];

  const today = new Date();
  const twoWeeksOut = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
  const from = today.toISOString().split('T')[0];
  const to = twoWeeksOut.toISOString().split('T')[0];

  try {
    const resp = await axios.get('https://finnhub.io/api/v1/calendar/economic', {
      params: { from, to, token: config.finnhubApiKey },
      timeout: 10000,
    });

    const events: any[] = resp.data?.economicCalendar || [];

    const filtered = events
      .filter((e: any) => e.country === 'US')
      .map((e: any) => ({
        event: e.event || 'Unknown Event',
        date: e.time?.split(' ')[0] || from,
        time: e.time?.split(' ')[1] || '',
        country: e.country || 'US',
        impact: classifyImpact(e.event || '', e.impact),
        actual: e.actual != null ? e.actual : undefined,
        estimate: e.estimate != null ? e.estimate : undefined,
        previous: e.prev != null ? e.prev : undefined,
      }))
      .filter((e: EconomicCalendarEvent) => e.impact === 'high' || e.impact === 'medium')
      .sort((a: EconomicCalendarEvent, b: EconomicCalendarEvent) => {
        // Sort by date, then by impact (high first)
        const dateCompare = a.date.localeCompare(b.date);
        if (dateCompare !== 0) return dateCompare;
        return a.impact === 'high' ? -1 : 1;
      })
      .slice(0, 20);

    cache.set('economic-calendar', filtered);
    return filtered;
  } catch (err) {
    console.error('[Economic Calendar] Fetch failed:', (err as Error).message);
    return [];
  }
}
