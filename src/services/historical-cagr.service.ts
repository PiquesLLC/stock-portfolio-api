import { yahooGet } from '../utils/yahoo-http';
import NodeCache from 'node-cache';

const YAHOO_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const cagrCache = new NodeCache({ stdTTL: 86400 }); // 24h cache

export interface HistoricalCAGR {
  ticker: string;
  cagr20yr: number | null;
  cagr10yr: number | null;
  cagr5yr: number | null;
  cagrMax: number | null;  // CAGR over all available data
  dataYears: number;
  startDate: string | null;
  endDate: string | null;
}

interface YahooQuoteData {
  close: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  open?: (number | null)[];
  volume?: (number | null)[];
}

interface YahooChartResult {
  chart: {
    result?: Array<{
      meta: { regularMarketPrice?: number };
      timestamp?: number[];
      indicators: { quote: YahooQuoteData[] };
    }>;
    error?: { code: string; description: string };
  };
}

/**
 * Fetch monthly candle data from Yahoo Finance for max available range.
 * Monthly interval keeps data compact even for 50yr history.
 */
async function fetchMonthlyCandles(
  ticker: string
): Promise<{ closes: number[]; dates: string[] } | null> {
  try {
    const response = await yahooGet(
      `${YAHOO_BASE_URL}/${encodeURIComponent(ticker.toUpperCase())}?interval=1mo&range=max`,
      15000
    );

    const result = response.data.chart.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]) return null;

    const timestamps = result.timestamp;
    const quote = result.indicators.quote[0];
    const closes: number[] = [];
    const dates: string[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const c = quote.close[i];
      if (c != null && c > 0) {
        closes.push(c);
        dates.push(new Date(timestamps[i] * 1000).toISOString().slice(0, 10));
      }
    }

    if (closes.length < 2) return null;
    return { closes, dates };
  } catch (err) {
    console.warn(
      `[HistoricalCAGR] Yahoo fetch failed for ${ticker}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Calculate CAGR over a specific number of years from monthly close data.
 * Finds the close price closest to `years` ago and computes annualized return.
 */
function calculateCAGR(
  closes: number[],
  dates: string[],
  years: number
): number | null {
  if (closes.length < 2) return null;

  const endPrice = closes[closes.length - 1];
  const endDate = new Date(dates[dates.length - 1]);
  const targetDate = new Date(endDate);
  targetDate.setFullYear(targetDate.getFullYear() - years);

  // Find the closest date on or after the target
  let startIdx = -1;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] >= targetDate.toISOString().slice(0, 10)) {
      startIdx = i;
      break;
    }
  }

  if (startIdx === -1 || startIdx === closes.length - 1) return null;

  const startPrice = closes[startIdx];
  if (startPrice <= 0) return null;

  // Actual span in years (may not be exactly `years`)
  const startD = new Date(dates[startIdx]);
  const actualYears =
    (endDate.getTime() - startD.getTime()) / (365.25 * 24 * 60 * 60 * 1000);

  if (actualYears < years * 0.8) return null; // Need at least 80% of requested span

  const totalReturn = endPrice / startPrice;
  if (totalReturn <= 0) return null;

  const cagr = Math.pow(totalReturn, 1 / actualYears) - 1;

  // Sanity bounds
  if (cagr > 2) return 2; // Cap at 200%
  if (cagr < -0.5) return -0.5; // Floor at -50%

  return Math.round(cagr * 10000) / 10000; // 4 decimal places
}

/**
 * Get historical CAGR for multiple tickers.
 * Results are cached for 24 hours.
 */
export async function getHistoricalCAGRs(
  tickers: string[]
): Promise<HistoricalCAGR[]> {
  const results: HistoricalCAGR[] = [];

  for (const ticker of tickers) {
    const upper = ticker.toUpperCase();
    const cacheKey = `cagr:${upper}`;

    // Check cache
    const cached = cagrCache.get<HistoricalCAGR>(cacheKey);
    if (cached) {
      results.push(cached);
      continue;
    }

    const candles = await fetchMonthlyCandles(upper);

    if (!candles || candles.closes.length < 12) {
      // Less than 1 year of data
      const empty: HistoricalCAGR = {
        ticker: upper,
        cagr20yr: null,
        cagr10yr: null,
        cagr5yr: null,
        cagrMax: null,
        dataYears: 0,
        startDate: null,
        endDate: null,
      };
      cagrCache.set(cacheKey, empty);
      results.push(empty);
      continue;
    }

    const startDate = candles.dates[0];
    const endDate = candles.dates[candles.dates.length - 1];
    const dataYears = Math.round(
      (new Date(endDate).getTime() - new Date(startDate).getTime()) /
        (365.25 * 24 * 60 * 60 * 1000) *
        10
    ) / 10;

    const cagr20yr = calculateCAGR(candles.closes, candles.dates, 20);
    const cagr10yr = calculateCAGR(candles.closes, candles.dates, 10);
    const cagr5yr = calculateCAGR(candles.closes, candles.dates, 5);

    // cagrMax: CAGR over all available data (first close → last close)
    let cagrMax: number | null = null;
    if (candles.closes.length >= 2 && dataYears >= 1) {
      const startPrice = candles.closes[0];
      const endPrice = candles.closes[candles.closes.length - 1];
      if (startPrice > 0 && endPrice > 0) {
        const totalReturn = endPrice / startPrice;
        let raw = Math.pow(totalReturn, 1 / dataYears) - 1;
        if (raw > 2) raw = 2;
        if (raw < -0.5) raw = -0.5;
        cagrMax = Math.round(raw * 10000) / 10000;
      }
    }

    const result: HistoricalCAGR = {
      ticker: upper,
      cagr20yr,
      cagr10yr,
      cagr5yr,
      cagrMax,
      dataYears,
      startDate,
      endDate,
    };

    cagrCache.set(cacheKey, result);
    results.push(result);
  }

  return results;
}
