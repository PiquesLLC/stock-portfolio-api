/**
 * Market data client — Polygon.io primary, Yahoo Finance fallback.
 * Polygon.io Stocks Developer plan ($79/mo): unlimited API calls,
 * 10-year history, minute aggregates, 15-min delayed data.
 * Yahoo is kept as fallback but is blocked from Railway datacenter IPs.
 */
import axios from 'axios';
import NodeCache from 'node-cache';

// ─── Polygon.io ─────────────────────────────────────────────────────────────

let _polygonApiKey: string | null = null;

async function getPolygonKey(): Promise<string | null> {
  if (_polygonApiKey !== null) return _polygonApiKey || null;
  const { config } = await import('../config');
  _polygonApiKey = config.polygonApiKey || '';
  return _polygonApiKey || null;
}

// Cache for Polygon results — keyed by request URL
const polygonCache = new NodeCache({ stdTTL: 300 }); // 5-min default
const polygonDailyCache = new NodeCache({ stdTTL: 86400 }); // 24h for daily candles

export interface PolygonCandleResult {
  timestamps: number[];
  closes: number[];
  highs: number[];
  lows: number[];
  opens: number[];
  volumes: number[];
}

/**
 * Generic Polygon.io aggregates (candle bars) fetcher.
 * @param ticker - Stock ticker
 * @param multiplier - Bar size multiplier (e.g., 5 for 5-minute bars)
 * @param timespan - Bar timespan: 'minute' | 'hour' | 'day' | 'week' | 'month'
 * @param from - Start date (YYYY-MM-DD)
 * @param to - End date (YYYY-MM-DD)
 * @param cacheTTL - Cache TTL in seconds (0 = use default per timespan)
 */
export async function fetchPolygonAggs(
  ticker: string,
  multiplier: number,
  timespan: string,
  from: string,
  to: string,
  cacheTTL?: number,
): Promise<PolygonCandleResult | null> {
  const apiKey = await getPolygonKey();
  if (!apiKey) return null;

  const upperTicker = ticker.toUpperCase();
  const cacheKey = `polygon:${upperTicker}:${multiplier}:${timespan}:${from}:${to}`;

  // Use daily cache for day+ timespans, short cache for intraday
  const cache = timespan === 'day' || timespan === 'week' || timespan === 'month'
    ? polygonDailyCache
    : polygonCache;
  const cached = cache.get<PolygonCandleResult>(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://api.polygon.io/v2/aggs/ticker/${upperTicker}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;
    const resp = await axios.get(url, { timeout: 15000 });

    if (resp.data?.results && resp.data.results.length > 0) {
      const results = resp.data.results;
      const data: PolygonCandleResult = {
        timestamps: results.map((r: any) => Math.floor(r.t / 1000)),
        closes: results.map((r: any) => r.c),
        highs: results.map((r: any) => r.h),
        lows: results.map((r: any) => r.l),
        opens: results.map((r: any) => r.o),
        volumes: results.map((r: any) => r.v ?? 0),
      };
      const ttl = cacheTTL ?? (timespan === 'day' ? 86400 : timespan === 'minute' ? 60 : 300);
      cache.set(cacheKey, data, ttl);
      console.log(`[Polygon] ${results.length} bars (${multiplier}${timespan}) for ${upperTicker}`);
      return data;
    }
    // No results but no error
    return null;
  } catch (err: any) {
    const msg = err?.response?.status ? `HTTP ${err.response.status}` : err?.code || err?.message || String(err);
    console.warn(`[Polygon] Failed ${upperTicker} (${multiplier}${timespan}): ${msg}`);
    return null;
  }
}

/**
 * Fetch daily candles from Polygon.io.
 * Backward-compatible wrapper used by snapshot.service.ts and other callers.
 */
export async function fetchFinnhubCandles(
  ticker: string,
  fromTimestamp: number,
  toTimestamp: number,
  _resolution: string = 'D',
): Promise<PolygonCandleResult | null> {
  const fromDate = new Date(fromTimestamp * 1000).toISOString().split('T')[0];
  const toDate = new Date(toTimestamp * 1000).toISOString().split('T')[0];
  return fetchPolygonAggs(ticker, 1, 'day', fromDate, toDate);
}

// ─── Yahoo Finance (fallback) ───────────────────────────────────────────────

let yahooCookie = '';
let yahooCrumb = '';
let yahooCookieExpiry = 0;
let cookieAttempts = 0;
let lastYahooSuccessMs = 0;

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function ensureYahooCookie(): Promise<void> {
  if (yahooCookie && yahooCrumb && Date.now() < yahooCookieExpiry) return;
  if (cookieAttempts > 0 && Date.now() < yahooCookieExpiry) return;
  cookieAttempts++;

  try {
    const initResp = await axios.get('https://finance.yahoo.com/quote/AAPL', {
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'User-Agent': YAHOO_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const setCookies = initResp.headers['set-cookie'];
    if (setCookies && setCookies.length > 0) {
      yahooCookie = setCookies.map((c: string) => c.split(';')[0]).join('; ');
    }

    if (yahooCookie) {
      const crumbResp = await axios.get('https://query2.finance.yahoo.com/v1/test/getcrumb', {
        timeout: 5000,
        headers: { 'User-Agent': YAHOO_UA, Cookie: yahooCookie },
        validateStatus: () => true,
      });
      if (crumbResp.status === 200 && crumbResp.data && typeof crumbResp.data === 'string' && crumbResp.data.length < 50) {
        yahooCrumb = crumbResp.data;
        yahooCookieExpiry = Date.now() + 3600000;
        return;
      }
    }

    // Fallback: fc.yahoo.com
    const fcResp = await axios.get('https://fc.yahoo.com', {
      timeout: 5000, maxRedirects: 5, validateStatus: () => true,
      headers: { 'User-Agent': YAHOO_UA },
    });
    const fcCookies = fcResp.headers['set-cookie'];
    if (fcCookies?.length) {
      yahooCookie = fcCookies.map((c: string) => c.split(';')[0]).join('; ');
      const crumbResp = await axios.get('https://query2.finance.yahoo.com/v1/test/getcrumb', {
        timeout: 5000,
        headers: { 'User-Agent': YAHOO_UA, Cookie: yahooCookie },
      });
      if (crumbResp.data && typeof crumbResp.data === 'string') {
        yahooCrumb = crumbResp.data;
        yahooCookieExpiry = Date.now() + 3600000;
        return;
      }
    }

    yahooCookieExpiry = Date.now() + (yahooCookie ? 600000 : 300000);
  } catch {
    yahooCookieExpiry = Date.now() + 300000;
  }
}

/**
 * Make an authenticated GET request to Yahoo Finance.
 */
export async function yahooGet(url: string, timeout = 5000) {
  await ensureYahooCookie();

  const headers: Record<string, string> = { 'User-Agent': YAHOO_UA };
  if (yahooCookie) headers['Cookie'] = yahooCookie;

  if (yahooCrumb) {
    const finalUrl = url + (url.includes('?') ? '&' : '?') + `crumb=${encodeURIComponent(yahooCrumb)}`;
    const q2Url = finalUrl.replace('query1.finance.yahoo.com', 'query2.finance.yahoo.com');
    try {
        const resp = await axios.get(q2Url, { timeout, headers });
        lastYahooSuccessMs = Date.now();
        return resp;
    } catch { /* fall through */ }
  }

  if (yahooCookie) headers['Cookie'] = yahooCookie;
  const resp = await axios.get(url, { timeout, headers });
  lastYahooSuccessMs = Date.now();
  return resp;
}

export function getYahooStatus(): { lastSuccessMs: number; cookieExpiryMs: number } {
  return {
    lastSuccessMs: lastYahooSuccessMs,
    cookieExpiryMs: yahooCookieExpiry,
  };
}
