import { getQuote, getQuotes, QuotesResult, searchSymbols } from '../utils/finnhub';
import { Quote, SymbolSearchResponse } from '../types';

// Using Finnhub for real-time market data
// Free tier: 60 API calls/minute

export async function fetchPrice(ticker: string): Promise<Quote> {
  return getQuote(ticker);
}

export async function fetchPrices(tickers: string[]): Promise<QuotesResult> {
  return getQuotes(tickers);
}

export async function fetchQuote(ticker: string): Promise<Quote> {
  return getQuote(ticker);
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
