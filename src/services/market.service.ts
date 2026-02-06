import { getQuote, getQuotes, QuotesResult, searchSymbols, getStockProfile, getStockMetrics, getHistoricalCandles } from '../utils/finnhub';
import { Quote, SymbolSearchResponse, StockProfile, StockMetrics, StockDetailsResponse } from '../types';
import { getMarketSession, getMarketSessionForTicker } from '../utils/market-hours';
import axios from 'axios';
import NodeCache from 'node-cache';

const yahooCache = new NodeCache({ stdTTL: 86400 }); // 24h cache for daily candles
const yahooIntradayCache = new NodeCache({ stdTTL: 10 }); // 10s cache for intraday

async function fetchYahooCandles(ticker: string): Promise<StockDetailsResponse['candles']> {
  const cacheKey = `yahoo:${ticker}`;
  const cached = yahooCache.get<StockDetailsResponse['candles']>(cacheKey);
  if (cached) return cached;

  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 10 * 365 * 24 * 60 * 60; // 10 years for MAX chart view
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${from}&period2=${now}&interval=1d`;
    const resp = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const result = resp.data?.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]) return null;

    const timestamps: number[] = result.timestamp;
    const q = result.indicators.quote[0];
    const closes: number[] = [];
    const dates: string[] = [];
    const highs: number[] = [];
    const lows: number[] = [];
    const opens: number[] = [];
    const volumes: number[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      if (q.close[i] != null) {
        closes.push(q.close[i]);
        dates.push(new Date(timestamps[i] * 1000).toISOString().slice(0, 10));
        highs.push(q.high?.[i] ?? 0);
        lows.push(q.low?.[i] ?? 0);
        opens.push(q.open?.[i] ?? 0);
        volumes.push(q.volume?.[i] ?? 0);
      }
    }

    if (closes.length === 0) return null;

    const candles: StockDetailsResponse['candles'] = { closes, dates, highs, lows, opens, volumes };
    yahooCache.set(cacheKey, candles);
    return candles;
  } catch (err) {
    console.warn(`Yahoo Finance candle fetch failed for ${ticker}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export interface IntradayCandle {
  time: string; // ISO timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function fetchIntradayCandles(ticker: string): Promise<IntradayCandle[]> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `yahoo-intra:${upperTicker}`;
  const cached = yahooIntradayCache.get<IntradayCandle[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(upperTicker)}?interval=5m&range=1d&includePrePost=true`;
    const resp = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const result = resp.data?.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]) return [];

    const timestamps: number[] = result.timestamp;
    const q = result.indicators.quote[0];
    const candles: IntradayCandle[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      if (q.close[i] != null) {
        candles.push({
          time: new Date(timestamps[i] * 1000).toISOString(),
          open: q.open?.[i] ?? q.close[i],
          high: q.high?.[i] ?? q.close[i],
          low: q.low?.[i] ?? q.close[i],
          close: q.close[i],
          volume: q.volume?.[i] ?? 0,
        });
      }
    }

    yahooIntradayCache.set(cacheKey, candles);
    return candles;
  } catch (err) {
    console.warn(`Yahoo intraday fetch failed for ${upperTicker}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

const yahooHourlyCache = new NodeCache({ stdTTL: 300 }); // 5min cache for hourly candles

/**
 * Fetch hourly candles from Yahoo Finance for a given range.
 * Used for 1W (15m interval, 5d range) and 1M (60m interval, 1mo range).
 */
export async function fetchHourlyCandles(ticker: string, period: '1W' | '1M'): Promise<IntradayCandle[]> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `yahoo-hourly:${upperTicker}:${period}`;
  const cached = yahooHourlyCache.get<IntradayCandle[]>(cacheKey);
  if (cached) return cached;

  try {
    const params = period === '1W'
      ? 'interval=15m&range=5d&includePrePost=true'
      : 'interval=60m&range=1mo&includePrePost=true';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(upperTicker)}?${params}`;
    const resp = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const result = resp.data?.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]) return [];

    const timestamps: number[] = result.timestamp;
    const q = result.indicators.quote[0];
    const candles: IntradayCandle[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      if (q.close[i] != null) {
        candles.push({
          time: new Date(timestamps[i] * 1000).toISOString(),
          open: q.open?.[i] ?? q.close[i],
          high: q.high?.[i] ?? q.close[i],
          low: q.low?.[i] ?? q.close[i],
          close: q.close[i],
          volume: q.volume?.[i] ?? 0,
        });
      }
    }

    yahooHourlyCache.set(cacheKey, candles);
    return candles;
  } catch (err) {
    console.warn(`Yahoo hourly fetch failed for ${upperTicker} (${period}):`, err instanceof Error ? err.message : err);
    return [];
  }
}

const yahooQuoteCache = new NodeCache({ stdTTL: 10 }); // 10s cache for live Yahoo quotes

/**
 * Fetch extended hours price from Yahoo Finance.
 * Returns { price, marketState } or null if unavailable.
 */
async function fetchYahooExtendedPrice(ticker: string): Promise<{ price: number; marketState: string } | null> {
  const cacheKey = `yahoo-quote:${ticker}`;
  const cached = yahooQuoteCache.get<{ price: number; marketState: string }>(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true`;
    const resp = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const meta = resp.data?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    // regularMarketPrice is regular close; for extended hours, get the last close from indicators
    const timestamps = resp.data.chart.result[0].timestamp;
    const closes = resp.data.chart.result[0].indicators?.quote?.[0]?.close;
    if (!timestamps || !closes || timestamps.length === 0) return null;

    // Find the last non-null close
    let lastPrice = meta.regularMarketPrice;
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) {
        lastPrice = closes[i];
        break;
      }
    }

    const result = { price: lastPrice, marketState: meta.marketState || 'REGULAR' };
    yahooQuoteCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

// Using Finnhub for real-time market data
// Free tier: 60 API calls/minute

export async function fetchPrice(ticker: string): Promise<Quote> {
  return getQuote(ticker);
}

export async function fetchPrices(tickers: string[]): Promise<QuotesResult> {
  const result = await getQuotes(tickers);

  // During extended hours, enrich all quotes with Yahoo's real-time extended prices
  const session = getMarketSession();
  if (session === 'PRE' || session === 'POST' || session === 'CLOSED') {
    const enrichPromises = Array.from(result.quotes.entries()).map(async ([ticker, quote]) => {
      quote.session = getMarketSessionForTicker(ticker);
      const qSession = quote.session;
      if (qSession === 'PRE' || qSession === 'POST' || qSession === 'CLOSED') {
        try {
          const yahoo = await fetchYahooExtendedPrice(ticker);
          if (yahoo && Math.abs(yahoo.price - quote.currentPrice) > 0.005) {
            quote.regularClose = quote.currentPrice;
            quote.extendedPrice = yahoo.price;
            quote.extendedChange = yahoo.price - quote.currentPrice;
            quote.extendedChangePercent = quote.currentPrice !== 0
              ? ((yahoo.price - quote.currentPrice) / quote.currentPrice) * 100
              : 0;
          }
        } catch { /* ignore individual failures */ }
      }
    });
    await Promise.all(enrichPromises);
  }

  return result;
}

export async function fetchQuote(ticker: string): Promise<Quote> {
  const quote = await getQuote(ticker);

  // Override session with per-ticker market hours (international/commodity aware)
  quote.session = getMarketSessionForTicker(ticker);

  // During extended hours, supplement with Yahoo's real-time extended price
  const session = quote.session;
  if (session === 'PRE' || session === 'POST' || session === 'CLOSED') {
    const yahoo = await fetchYahooExtendedPrice(ticker.toUpperCase());
    if (yahoo && Math.abs(yahoo.price - quote.currentPrice) > 0.005) {
      quote.regularClose = quote.currentPrice;
      quote.extendedPrice = yahoo.price;
      quote.extendedChange = yahoo.price - quote.currentPrice;
      quote.extendedChangePercent = quote.currentPrice !== 0
        ? ((yahoo.price - quote.currentPrice) / quote.currentPrice) * 100
        : 0;
    }
  }

  return quote;
}

/**
 * Fetch a basic quote from Yahoo Finance as fallback when Finnhub has no data.
 */
async function fetchYahooQuote(ticker: string): Promise<Quote | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true`;
    const resp = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const meta = resp.data?.chart?.result?.[0]?.meta;
    if (!meta || !meta.regularMarketPrice) return null;

    const timestamps = resp.data.chart.result[0].timestamp;
    const closes = resp.data.chart.result[0].indicators?.quote?.[0]?.close;

    // Find last non-null close for extended hours
    let lastPrice = meta.regularMarketPrice;
    if (timestamps && closes) {
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] != null) {
          lastPrice = closes[i];
          break;
        }
      }
    }

    const session = getMarketSessionForTicker(ticker);
    const previousClose = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;
    const currentPrice = meta.regularMarketPrice;
    const change = currentPrice - previousClose;
    const changePercent = previousClose !== 0 ? (change / previousClose) * 100 : 0;

    const quote: Quote = {
      ticker: ticker.toUpperCase(),
      currentPrice,
      change,
      changePercent,
      high: meta.regularMarketDayHigh || currentPrice,
      low: meta.regularMarketDayLow || currentPrice,
      open: meta.regularMarketOpen || currentPrice,
      previousClose,
      timestamp: Math.floor(Date.now() / 1000),
      updatedAt: Date.now(),
      isStale: false,
      isRepricing: false,
      quoteAgeSeconds: 0,
      session,
    };

    // Add extended hours if price differs
    if (session !== 'REG' && Math.abs(lastPrice - currentPrice) > 0.005) {
      quote.regularClose = currentPrice;
      quote.extendedPrice = lastPrice;
      quote.extendedChange = lastPrice - currentPrice;
      quote.extendedChangePercent = currentPrice !== 0
        ? ((lastPrice - currentPrice) / currentPrice) * 100
        : 0;
    }

    return quote;
  } catch {
    return null;
  }
}

/**
 * Fast quote fetch using Yahoo Finance directly - no queue, no rate limits.
 * Used for progressive loading to show price immediately.
 */
export async function fetchFastQuote(ticker: string): Promise<Quote | null> {
  return fetchYahooQuote(ticker);
}

export async function fetchStockDetails(ticker: string): Promise<StockDetailsResponse> {
  const upperTicker = ticker.toUpperCase();

  // Use Yahoo for quote + candles (fast, no queue), Finnhub only for profile + metrics
  const [quote, profileRaw, metricsRaw, candles] = await Promise.all([
    fetchYahooQuote(upperTicker).catch(() => null),
    getStockProfile(upperTicker).catch(() => null),
    getStockMetrics(upperTicker).catch(() => null),
    fetchYahooCandles(upperTicker).catch(() => null),
  ]);

  if (!quote) {
    // Last resort: try Finnhub quote through the queue
    const finnhubQuote = await fetchQuote(upperTicker).catch(() => null);
    if (!finnhubQuote) {
      throw new Error(`No quote data available for ${upperTicker}`);
    }
    return { ticker: upperTicker, quote: finnhubQuote, profile: null, metrics: null, candles };
  }

  // Map profile
  let profile: StockProfile | null = null;
  if (profileRaw) {
    profile = {
      ticker: upperTicker,
      name: profileRaw.name || upperTicker,
      description: '', // profile2 doesn't include description
      logo: profileRaw.logo || '',
      industry: profileRaw.finnhubIndustry || '',
      marketCapM: profileRaw.marketCapitalization || 0,
      ipoDate: profileRaw.ipo || '',
      weburl: profileRaw.weburl || '',
      country: profileRaw.country || '',
      exchange: profileRaw.exchange || '',
      phone: profileRaw.phone || '',
    };
  }

  // Map metrics
  let metrics: StockMetrics | null = null;
  if (metricsRaw?.metric) {
    const m = metricsRaw.metric;
    metrics = {
      ticker: upperTicker,
      peRatio: m.peBasicExclExtraTTM ?? null,
      week52High: m['52WeekHigh'] ?? null,
      week52Low: m['52WeekLow'] ?? null,
      dividendYield: m.dividendYieldIndicatedAnnual ?? null,
      avgVolume10D: m['10DayAverageTradingVolume'] ?? null,
      beta: m.beta ?? null,
      eps: m.epsBasicExclExtraItemsTTM ?? null,
    };
  }

  return { ticker: upperTicker, quote, profile, metrics, candles };
}

export async function searchTickers(
  query: string,
  heldTickers: string[] = []
): Promise<SymbolSearchResponse> {
  const { results, partial, cached, advPending } = await searchSymbols(query, heldTickers);

  return {
    results,
    meta: {
      query,
      count: results.length,
      partial,
      cached,
      advPending,
    },
  };
}
