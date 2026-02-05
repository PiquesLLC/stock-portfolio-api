/**
 * Alpha Vantage API Client
 *
 * Free tier: 25 calls/day, 5 calls/min
 * All requests go through a queue with 13s minimum delay.
 * Daily call count is persisted to SQLite so it survives restarts.
 */

import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { config } from '../config';

const prisma = new PrismaClient();
const AV_BASE_URL = 'https://www.alphavantage.co/query';
const MIN_REQUEST_DELAY_MS = 13000; // 5/min = 12s, +1s safety
const MAX_RETRIES = 2;

// ── Daily budget tracker ──────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getDailyUsage(): Promise<{ callCount: number; tickers: string }> {
  const today = todayStr();
  const row = await prisma.aVDailyUsage.findUnique({ where: { date: today } });
  return row ?? { callCount: 0, tickers: '' };
}

async function incrementDailyUsage(ticker?: string): Promise<void> {
  const today = todayStr();
  const existing = await prisma.aVDailyUsage.findUnique({ where: { date: today } });

  if (existing) {
    const tickers = ticker && !existing.tickers.includes(ticker)
      ? (existing.tickers ? `${existing.tickers},${ticker}` : ticker)
      : existing.tickers;
    await prisma.aVDailyUsage.update({
      where: { date: today },
      data: { callCount: existing.callCount + 1, tickers },
    });
  } else {
    await prisma.aVDailyUsage.create({
      data: { date: today, callCount: 1, tickers: ticker ?? '' },
    });
  }
}

export async function getDailyCallsRemaining(): Promise<number> {
  const usage = await getDailyUsage();
  return Math.max(0, config.alphaVantageDailyLimit - usage.callCount);
}

export async function getDailyStats(): Promise<{ date: string; callCount: number; limit: number; remaining: number; tickers: string }> {
  const usage = await getDailyUsage();
  return {
    date: todayStr(),
    callCount: usage.callCount,
    limit: config.alphaVantageDailyLimit,
    remaining: Math.max(0, config.alphaVantageDailyLimit - usage.callCount),
    tickers: usage.tickers,
  };
}

// ── Request queue ─────────────────────────────────────────────────

interface QueuedRequest<T> {
  params: Record<string, string>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  retries: number;
  ticker?: string;
}

class AlphaVantageQueue {
  private queue: QueuedRequest<unknown>[] = [];
  private isProcessing = false;
  private lastRequestTime = 0;

  async request<T>(params: Record<string, string>, ticker?: string): Promise<T> {
    // Check daily budget before queueing
    const remaining = await getDailyCallsRemaining();
    if (remaining <= 0) {
      throw new Error('AV_DAILY_LIMIT_REACHED: Alpha Vantage daily call limit exhausted');
    }

    if (!config.alphaVantageApiKey || config.alphaVantageApiKey === 'REPLACE_WITH_YOUR_KEY') {
      throw new Error('AV_NO_API_KEY: Alpha Vantage API key not configured');
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        params,
        resolve: resolve as (value: unknown) => void,
        reject,
        retries: 0,
        ticker,
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const req = this.queue[0];

      // Enforce minimum delay between requests
      const elapsed = Date.now() - this.lastRequestTime;
      if (elapsed < MIN_REQUEST_DELAY_MS) {
        await this.sleep(MIN_REQUEST_DELAY_MS - elapsed);
      }

      try {
        const result = await this.executeRequest(req);
        await incrementDailyUsage(req.ticker);
        req.resolve(result);
        this.queue.shift();
      } catch (error) {
        const status = (error as any)?.response?.status;

        if (status === 429 && req.retries < MAX_RETRIES) {
          req.retries++;
          const backoff = 15000 * Math.pow(2, req.retries - 1);
          console.warn(`[AV] Rate limited (429), retry ${req.retries}/${MAX_RETRIES} in ${backoff}ms`);
          await this.sleep(backoff);
        } else {
          req.reject(error instanceof Error ? error : new Error(String(error)));
          this.queue.shift();
        }
      }

      this.lastRequestTime = Date.now();
    }

    this.isProcessing = false;
  }

  private async executeRequest<T>(req: QueuedRequest<T>): Promise<T> {
    const response = await axios.get<T>(AV_BASE_URL, {
      params: {
        ...req.params,
        apikey: config.alphaVantageApiKey,
      },
      timeout: 15000,
    });

    // AV returns 200 with error message in body for invalid requests
    const data = response.data as any;
    if (data?.['Error Message']) {
      throw new Error(`AV_ERROR: ${data['Error Message']}`);
    }
    if (data?.Note?.includes('call frequency')) {
      throw new Error('AV_RATE_LIMIT: API call frequency exceeded');
    }
    if (data?.Information?.includes('rate limit')) {
      throw new Error('AV_RATE_LIMIT: API rate limit reached');
    }

    return response.data;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}

export const avQueue = new AlphaVantageQueue();

// ── Helpers ───────────────────────────────────────────────────────

/** Parse AV string values ("None", "", undefined) to number | null */
export function parseAVNumber(value: string | undefined | null): number | null {
  if (!value || value === 'None' || value === '-' || value === '.') return null;
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

// ── Company Overview ──────────────────────────────────────────────

export interface AVCompanyOverview {
  Symbol: string;
  Name: string;
  Description: string;
  Sector: string;
  Industry: string;
  MarketCapitalization: string;
  PERatio: string;
  PEGRatio: string;
  EPS: string;
  DilutedEPSTTM: string;
  RevenueTTM: string;
  GrossProfitTTM: string;
  ProfitMargin: string;
  OperatingMarginTTM: string;
  ReturnOnEquityTTM: string;
  Beta: string;
  ForwardPE: string;
  TrailingPE: string;
  DividendYield: string;
  DividendPerShare: string;
  AnalystTargetPrice: string;
  '52WeekHigh': string;
  '52WeekLow': string;
  '50DayMovingAverage': string;
  '200DayMovingAverage': string;
  SharesOutstanding: string;
  BookValue: string;
  EVToRevenue: string;
  EVToEBITDA: string;
  [key: string]: string;
}

export async function fetchCompanyOverview(ticker: string): Promise<AVCompanyOverview | null> {
  try {
    const data = await avQueue.request<AVCompanyOverview>(
      { function: 'OVERVIEW', symbol: ticker.toUpperCase() },
      ticker.toUpperCase(),
    );
    // Empty response means ticker not found
    if (!data?.Symbol) return null;
    return data;
  } catch (err) {
    console.error(`[AV] Overview fetch failed for ${ticker}:`, (err as Error).message);
    return null;
  }
}

// ── Income Statement ──────────────────────────────────────────────

export interface AVFinancialReport {
  fiscalDateEnding: string;
  reportedCurrency: string;
  [key: string]: string;
}

export interface AVIncomeStatement {
  symbol: string;
  annualReports: AVFinancialReport[];
  quarterlyReports: AVFinancialReport[];
}

export async function fetchIncomeStatement(ticker: string): Promise<AVIncomeStatement | null> {
  try {
    const data = await avQueue.request<AVIncomeStatement>(
      { function: 'INCOME_STATEMENT', symbol: ticker.toUpperCase() },
      ticker.toUpperCase(),
    );
    if (!data?.annualReports) return null;
    return data;
  } catch (err) {
    console.error(`[AV] Income statement fetch failed for ${ticker}:`, (err as Error).message);
    return null;
  }
}

// ── Balance Sheet ─────────────────────────────────────────────────

export interface AVBalanceSheet {
  symbol: string;
  annualReports: AVFinancialReport[];
  quarterlyReports: AVFinancialReport[];
}

export async function fetchBalanceSheet(ticker: string): Promise<AVBalanceSheet | null> {
  try {
    const data = await avQueue.request<AVBalanceSheet>(
      { function: 'BALANCE_SHEET', symbol: ticker.toUpperCase() },
      ticker.toUpperCase(),
    );
    if (!data?.annualReports) return null;
    return data;
  } catch (err) {
    console.error(`[AV] Balance sheet fetch failed for ${ticker}:`, (err as Error).message);
    return null;
  }
}

// ── Cash Flow ─────────────────────────────────────────────────────

export interface AVCashFlow {
  symbol: string;
  annualReports: AVFinancialReport[];
  quarterlyReports: AVFinancialReport[];
}

export async function fetchCashFlow(ticker: string): Promise<AVCashFlow | null> {
  try {
    const data = await avQueue.request<AVCashFlow>(
      { function: 'CASH_FLOW', symbol: ticker.toUpperCase() },
      ticker.toUpperCase(),
    );
    if (!data?.annualReports) return null;
    return data;
  } catch (err) {
    console.error(`[AV] Cash flow fetch failed for ${ticker}:`, (err as Error).message);
    return null;
  }
}

// ── Earnings ──────────────────────────────────────────────────────

export interface AVQuarterlyEarning {
  fiscalDateEnding: string;
  reportedDate: string;
  reportedEPS: string;
  estimatedEPS: string;
  surprise: string;
  surprisePercentage: string;
}

export interface AVEarnings {
  symbol: string;
  annualEarnings: { fiscalDateEnding: string; reportedEPS: string }[];
  quarterlyEarnings: AVQuarterlyEarning[];
}

export async function fetchEarnings(ticker: string): Promise<AVEarnings | null> {
  try {
    const data = await avQueue.request<AVEarnings>(
      { function: 'EARNINGS', symbol: ticker.toUpperCase() },
      ticker.toUpperCase(),
    );
    if (!data?.quarterlyEarnings) return null;
    return data;
  } catch (err) {
    console.error(`[AV] Earnings fetch failed for ${ticker}:`, (err as Error).message);
    return null;
  }
}

// ── Economic Indicators ───────────────────────────────────────────

export interface AVEconomicData {
  name: string;
  interval: string;
  unit: string;
  data: { date: string; value: string }[];
}

export async function fetchCPI(): Promise<AVEconomicData | null> {
  try {
    return await avQueue.request<AVEconomicData>({ function: 'CPI', interval: 'monthly' });
  } catch (err) {
    console.error('[AV] CPI fetch failed:', (err as Error).message);
    return null;
  }
}

export async function fetchFedFundsRate(): Promise<AVEconomicData | null> {
  try {
    return await avQueue.request<AVEconomicData>({ function: 'FEDERAL_FUNDS_RATE', interval: 'monthly' });
  } catch (err) {
    console.error('[AV] Fed funds rate fetch failed:', (err as Error).message);
    return null;
  }
}

export async function fetchTreasuryYield(maturity: string = '10year'): Promise<AVEconomicData | null> {
  try {
    return await avQueue.request<AVEconomicData>({ function: 'TREASURY_YIELD', interval: 'monthly', maturity });
  } catch (err) {
    console.error('[AV] Treasury yield fetch failed:', (err as Error).message);
    return null;
  }
}

export async function fetchUnemployment(): Promise<AVEconomicData | null> {
  try {
    return await avQueue.request<AVEconomicData>({ function: 'UNEMPLOYMENT' });
  } catch (err) {
    console.error('[AV] Unemployment fetch failed:', (err as Error).message);
    return null;
  }
}

export async function fetchGDP(): Promise<AVEconomicData | null> {
  try {
    return await avQueue.request<AVEconomicData>({ function: 'REAL_GDP', interval: 'quarterly' });
  } catch (err) {
    console.error('[AV] GDP fetch failed:', (err as Error).message);
    return null;
  }
}
