/**
 * Yahoo Finance HTTP client with cookie/crumb authentication.
 * Yahoo blocks datacenter IPs (like Railway) unless requests include
 * consent cookies and a crumb token. This module handles that transparently.
 */
import axios from 'axios';

let yahooCookie = '';
let yahooCrumb = '';
let yahooCookieExpiry = 0;
let cookieAttempts = 0;

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function ensureYahooCookie(): Promise<void> {
  if (yahooCookie && yahooCrumb && Date.now() < yahooCookieExpiry) return;

  // Don't retry too often if it keeps failing
  if (cookieAttempts > 0 && Date.now() < yahooCookieExpiry) return;

  cookieAttempts++;

  try {
    // Method 1: Use the Yahoo consent cookie approach
    // The A3 cookie with value "d=AQ..." bypasses consent screens
    // First, try getting cookies from the Yahoo Finance page
    const initResp = await axios.get('https://finance.yahoo.com/quote/AAPL', {
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'User-Agent': YAHOO_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });

    console.log(`[Yahoo] finance.yahoo.com responded with HTTP ${initResp.status}`);
    const setCookies = initResp.headers['set-cookie'];
    if (setCookies && setCookies.length > 0) {
      yahooCookie = setCookies.map((c: string) => c.split(';')[0]).join('; ');
      console.log(`[Yahoo] Got ${setCookies.length} cookies from finance.yahoo.com`);
    } else {
      console.warn('[Yahoo] No set-cookie headers from finance.yahoo.com');
    }

    // Try to get crumb with the cookies we have
    if (yahooCookie) {
      try {
        const crumbResp = await axios.get('https://query2.finance.yahoo.com/v1/test/getcrumb', {
          timeout: 10000,
          headers: { 'User-Agent': YAHOO_UA, Cookie: yahooCookie },
          validateStatus: () => true,
        });

        if (crumbResp.status === 200 && crumbResp.data && typeof crumbResp.data === 'string' && crumbResp.data.length < 50) {
          yahooCrumb = crumbResp.data;
          yahooCookieExpiry = Date.now() + 3600000; // 1 hour
          console.log('[Yahoo] Cookie/crumb obtained successfully');
          return;
        }
      } catch (crumbErr) {
        console.warn('[Yahoo] Crumb fetch failed:', crumbErr instanceof Error ? crumbErr.message : crumbErr);
      }
    }

    // Method 2: Try fc.yahoo.com as fallback
    try {
      const fcResp = await axios.get('https://fc.yahoo.com', {
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: { 'User-Agent': YAHOO_UA },
      });

      const fcCookies = fcResp.headers['set-cookie'];
      if (fcCookies && fcCookies.length > 0) {
        yahooCookie = fcCookies.map((c: string) => c.split(';')[0]).join('; ');

        const crumbResp = await axios.get('https://query2.finance.yahoo.com/v1/test/getcrumb', {
          timeout: 10000,
          headers: { 'User-Agent': YAHOO_UA, Cookie: yahooCookie },
        });

        if (crumbResp.data && typeof crumbResp.data === 'string') {
          yahooCrumb = crumbResp.data;
          yahooCookieExpiry = Date.now() + 3600000;
          console.log('[Yahoo] Cookie/crumb obtained via fc.yahoo.com');
          return;
        }
      }
    } catch {
      // fc.yahoo.com also failed
    }

    // If we got cookies but no crumb, still use cookies (query1 may work without crumb)
    if (yahooCookie) {
      yahooCookieExpiry = Date.now() + 600000; // Retry in 10 min
      console.log('[Yahoo] Got cookies but no crumb — will use cookies only');
    } else {
      yahooCookieExpiry = Date.now() + 300000; // Retry in 5 min
      console.warn('[Yahoo] Failed to obtain any cookies');
    }
  } catch (err: any) {
    const msg = err?.response?.status
      ? `HTTP ${err.response.status} ${err.response.statusText || ''}`
      : err?.code || err?.message || String(err);
    console.warn('[Yahoo] Cookie acquisition failed:', msg);
    yahooCookieExpiry = Date.now() + 300000; // Retry in 5 min
  }
}

/**
 * Make an authenticated GET request to Yahoo Finance.
 * Automatically handles cookie/crumb and falls back to unauthenticated if needed.
 */
export async function yahooGet(url: string, timeout = 5000) {
  await ensureYahooCookie();

  const headers: Record<string, string> = { 'User-Agent': YAHOO_UA };
  if (yahooCookie) headers['Cookie'] = yahooCookie;

  // If we have a crumb, try query2 with crumb first
  if (yahooCrumb) {
    const finalUrl = url + (url.includes('?') ? '&' : '?') + `crumb=${encodeURIComponent(yahooCrumb)}`;
    const q2Url = finalUrl.replace('query1.finance.yahoo.com', 'query2.finance.yahoo.com');

    try {
      return await axios.get(q2Url, { timeout, headers });
    } catch {
      // Fall through to raw request
    }
  }

  // Single attempt with cookies or without — don't waste time on multiple retries
  // if Yahoo is blocking our IP entirely
  if (yahooCookie) {
    headers['Cookie'] = yahooCookie;
  }
  return await axios.get(url, { timeout, headers });
}

/**
 * Fetch daily candles using Polygon.io as a fallback when Yahoo is blocked.
 * Polygon free tier supports 5 requests/min with daily candle data.
 */
export async function fetchFinnhubCandles(
  ticker: string,
  fromTimestamp: number,
  toTimestamp: number,
  _resolution: string = 'D',
): Promise<{ timestamps: number[]; closes: number[]; highs: number[]; lows: number[]; opens: number[] } | null> {
  try {
    const { config } = await import('../config');

    // Use Polygon.io for historical candles (free tier: 5 req/min, daily candles)
    if (config.polygonApiKey) {
      const fromDate = new Date(fromTimestamp * 1000).toISOString().split('T')[0];
      const toDate = new Date(toTimestamp * 1000).toISOString().split('T')[0];
      const url = `https://api.polygon.io/v2/aggs/ticker/${ticker.toUpperCase()}/range/1/day/${fromDate}/${toDate}?adjusted=true&sort=asc&apiKey=${config.polygonApiKey}`;

      const resp = await axios.get(url, { timeout: 10000 });

      if (resp.data?.results && resp.data.results.length > 0) {
        const results = resp.data.results;
        console.log(`[Polygon] Got ${results.length} daily candles for ${ticker}`);
        return {
          timestamps: results.map((r: any) => Math.floor(r.t / 1000)), // Polygon uses ms, convert to seconds
          closes: results.map((r: any) => r.c),
          highs: results.map((r: any) => r.h),
          lows: results.map((r: any) => r.l),
          opens: results.map((r: any) => r.o),
        };
      }
      console.warn(`[Polygon] No results for ${ticker}: count=${resp.data?.resultsCount}`);
    }

    return null;
  } catch (err: any) {
    const msg = err?.response?.status ? `HTTP ${err.response.status}` : err?.code || err?.message || String(err);
    console.warn(`[Polygon] Failed for ${ticker}: ${msg}`);
    return null;
  }
}
