import { getQuote, getQuotes, QuotesResult } from '../utils/finnhub';
import { Quote } from '../types';

export async function fetchPrice(ticker: string): Promise<Quote> {
  return getQuote(ticker);
}

export async function fetchPrices(tickers: string[]): Promise<QuotesResult> {
  return getQuotes(tickers);
}

export async function fetchQuote(ticker: string): Promise<Quote> {
  return getQuote(ticker);
}
