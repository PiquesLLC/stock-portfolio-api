import axios from 'axios';
import NodeCache from 'node-cache';
import { config } from '../config';

export interface MarketNewsItem {
  id: number;
  headline: string;
  source: string;
  url: string;
  summary: string;
  image: string;
  datetime: number;
  related: string;
  category: string;
}

const newsCache = new NodeCache({ stdTTL: 150 }); // 2.5 min

// Keywords that indicate non-market lifestyle/personal finance articles
const LIFESTYLE_KEYWORDS = [
  'engagement ring', 'wedding', 'marriage', 'divorce', 'dating',
  'vacation', 'travel tips', 'holiday gift', 'gift guide',
  'recipe', 'diet', 'weight loss', 'fitness',
  'celebrity', 'kardashian', 'royal family',
  'horoscope', 'zodiac', 'astrology',
  'parenting', 'relationship advice',
  'side hustle', 'make money fast', 'get rich',
  'credit score hack', 'budget hack',
  'best credit card', 'best savings account', // generic listicles
  'streaming', 'netflix', 'what to watch',
  'super bowl commercial', 'halftime show',
];

const LIFESTYLE_PATTERN = new RegExp(LIFESTYLE_KEYWORDS.join('|'), 'i');

function isMarketRelevant(item: MarketNewsItem): boolean {
  const text = `${item.headline} ${item.summary}`.toLowerCase();

  // Exclude lifestyle content
  if (LIFESTYLE_PATTERN.test(text)) return false;

  // Include if it mentions markets, stocks, economy, companies, etc.
  const marketKeywords = /stock|market|trade|invest|economy|fed|inflation|gdp|earnings|revenue|profit|ipo|merger|acquisition|sec|nasdaq|dow|s&p|bond|yield|rate|tariff|oil|gold|crypto|bitcoin|etf/i;

  // If headline has market keywords, include it
  if (marketKeywords.test(item.headline)) return true;

  // If from financial sources and not lifestyle, include it
  const financialSources = ['reuters', 'bloomberg', 'wsj', 'cnbc', 'financial times', 'barron'];
  const sourceLower = item.source.toLowerCase();
  if (financialSources.some(s => sourceLower.includes(s))) return true;

  // Check if summary has strong market signals
  if (marketKeywords.test(item.summary)) return true;

  // Default: exclude uncertain content
  return false;
}

const tickerNewsCache = new NodeCache({ stdTTL: 300 }); // 5 min

export function invalidateMarketNewsCache(): void {
  newsCache.del('market-news');
}

export function invalidateTickerNewsCache(tickers?: string[] | string): void {
  if (!tickers) {
    tickerNewsCache.flushAll();
    return;
  }
  const list = Array.isArray(tickers) ? tickers : [tickers];
  for (const t of list) {
    tickerNewsCache.del(`news-${t.toUpperCase()}`);
  }
}

export function invalidateAllNewsCache(): void {
  newsCache.flushAll();
  tickerNewsCache.flushAll();
}

export async function fetchTickerNews(ticker: string, limit = 30): Promise<MarketNewsItem[]> {
  const upper = ticker.toUpperCase();
  const cached = tickerNewsCache.get<MarketNewsItem[]>(`news-${upper}`);
  if (cached) return cached.slice(0, limit);

  // Finnhub company news: last 30 days
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const resp = await axios.get<MarketNewsItem[]>('https://finnhub.io/api/v1/company-news', {
    params: { symbol: upper, from, to, token: config.finnhubApiKey },
    timeout: 8000,
  });

  const items = (resp.data || []).slice(0, 50);
  tickerNewsCache.set(`news-${upper}`, items);
  return items.slice(0, limit);
}

export async function fetchMarketNews(limit = 20): Promise<MarketNewsItem[]> {
  const cached = newsCache.get<MarketNewsItem[]>('market-news');
  if (cached) return cached.slice(0, limit);

  const resp = await axios.get<MarketNewsItem[]>('https://finnhub.io/api/v1/news', {
    params: { category: 'general', token: config.finnhubApiKey },
    timeout: 8000,
  });

  const items = (resp.data || []).filter(isMarketRelevant);
  newsCache.set('market-news', items);
  return items.slice(0, limit);
}
