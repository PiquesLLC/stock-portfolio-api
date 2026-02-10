/**
 * Yahoo Finance HTTP client with cookie/crumb authentication.
 * Yahoo blocks datacenter IPs (like Railway) unless requests include
 * consent cookies and a crumb token. This module handles that transparently.
 */
import axios from 'axios';

let yahooCookie = '';
let yahooCrumb = '';
let yahooCookieExpiry = 0;

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function ensureYahooCookie(): Promise<void> {
  if (yahooCookie && yahooCrumb && Date.now() < yahooCookieExpiry) return;

  try {
    // Step 1: Get consent cookies
    const cookieResp = await axios.get('https://fc.yahoo.com', {
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { 'User-Agent': YAHOO_UA },
    });

    const setCookies = cookieResp.headers['set-cookie'];
    if (setCookies) {
      yahooCookie = setCookies.map((c: string) => c.split(';')[0]).join('; ');
    }

    // Step 2: Get crumb using the cookies
    const crumbResp = await axios.get('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      timeout: 10000,
      headers: { 'User-Agent': YAHOO_UA, Cookie: yahooCookie },
    });

    yahooCrumb = crumbResp.data;
    yahooCookieExpiry = Date.now() + 3600000; // 1 hour
    console.log('[Yahoo] Cookie/crumb obtained successfully');
  } catch (err) {
    console.warn('[Yahoo] Failed to obtain cookie/crumb:', err instanceof Error ? err.message : err);
    yahooCookie = '';
    yahooCrumb = '';
    yahooCookieExpiry = 0;
  }
}

/**
 * Make an authenticated GET request to Yahoo Finance.
 * Automatically handles cookie/crumb and falls back to unauthenticated if needed.
 */
export async function yahooGet(url: string, timeout = 10000) {
  await ensureYahooCookie();

  const headers: Record<string, string> = { 'User-Agent': YAHOO_UA };
  if (yahooCookie) headers['Cookie'] = yahooCookie;

  // Append crumb if available
  const finalUrl = yahooCrumb && !url.includes('crumb=')
    ? url + (url.includes('?') ? '&' : '?') + `crumb=${encodeURIComponent(yahooCrumb)}`
    : url;

  // Try query2 first (works with crumb), fall back to query1
  const q2Url = finalUrl.replace('query1.finance.yahoo.com', 'query2.finance.yahoo.com');

  try {
    return await axios.get(q2Url, { timeout, headers });
  } catch {
    // Fallback to query1 without crumb
    return await axios.get(url, { timeout, headers: { 'User-Agent': YAHOO_UA } });
  }
}
