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

export async function fetchMarketNews(limit = 20): Promise<MarketNewsItem[]> {
  const cached = newsCache.get<MarketNewsItem[]>('market-news');
  if (cached) return cached.slice(0, limit);

  const resp = await axios.get<MarketNewsItem[]>('https://finnhub.io/api/v1/news', {
    params: { category: 'general', token: config.finnhubApiKey },
    timeout: 8000,
  });

  const items = resp.data || [];
  newsCache.set('market-news', items);
  return items.slice(0, limit);
}
