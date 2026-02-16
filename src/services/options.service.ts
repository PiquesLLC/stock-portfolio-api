/**
 * Options Pricing Service
 *
 * Fetches live options prices from Finnhub's option chain endpoint.
 * Groups requests by (underlying, expiry) to minimize API calls.
 */

import NodeCache from 'node-cache';
import { finnhubQueue } from '../utils/finnhub-queue';

// Cache option chains for 30 seconds (same as equity quotes)
const optionChainCache = new NodeCache({ stdTTL: 30 });

// Backup cache for when API is rate-limited (5 minutes)
const optionBackupCache = new NodeCache({ stdTTL: 300 });

export interface OptionQuote {
  lastPrice: number;
  bid: number;
  ask: number;
  midPrice: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  change: number;
  percentChange: number;
}

interface FinnhubOptionContract {
  contractName?: string;
  strike: number;
  lastPrice: number;
  bid: number;
  ask: number;
  change: number;
  percentChange: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  inTheMoney: boolean;
}

interface FinnhubOptionChainExpiry {
  expirationDate: string;
  options: {
    CALL?: FinnhubOptionContract[];
    PUT?: FinnhubOptionContract[];
  };
}

interface FinnhubOptionChainResponse {
  code: string;
  data: FinnhubOptionChainExpiry[];
}

interface OptionPosition {
  ticker: string;           // OCC symbol (used as key)
  underlying: string;       // e.g., "AAPL"
  expiry: string;           // e.g., "2026-03-20"
  strike: number;           // e.g., 230.00
  type: 'call' | 'put';
}

/**
 * Fetch live option quotes for a list of option positions.
 * Groups by (underlying, expiry) to minimize Finnhub API calls.
 */
export async function getOptionQuotes(
  positions: OptionPosition[]
): Promise<Map<string, OptionQuote>> {
  const results = new Map<string, OptionQuote>();

  if (positions.length === 0) return results;

  // Group positions by underlying + expiry
  const groups = new Map<string, OptionPosition[]>();
  for (const pos of positions) {
    const key = `${pos.underlying}:${pos.expiry}`;
    const group = groups.get(key);
    if (group) {
      group.push(pos);
    } else {
      groups.set(key, [pos]);
    }
  }

  // Fetch each group (one API call per unique underlying+expiry)
  const fetches = Array.from(groups.entries()).map(async ([groupKey, groupPositions]) => {
    try {
      const chain = await fetchOptionChain(groupPositions[0].underlying, groupPositions[0].expiry);
      if (!chain) return;

      // Match each position in this group to a contract in the chain
      for (const pos of groupPositions) {
        const contract = findContract(chain, pos.strike, pos.type);
        if (contract) {
          const mid = contract.bid > 0 && contract.ask > 0
            ? (contract.bid + contract.ask) / 2
            : contract.lastPrice;

          results.set(pos.ticker, {
            lastPrice: contract.lastPrice,
            bid: contract.bid,
            ask: contract.ask,
            midPrice: mid,
            volume: contract.volume,
            openInterest: contract.openInterest,
            impliedVolatility: contract.impliedVolatility,
            change: contract.change,
            percentChange: contract.percentChange,
          });
        }
      }
    } catch {
      // Non-fatal: positions in this group just won't have quotes
      console.error(`[Options] Failed to fetch chain for ${groupKey}`);
    }
  });

  // Run fetches sequentially to respect Finnhub rate limits
  // (finnhubQueue handles the actual throttling, but running
  //  sequentially avoids flooding the queue)
  for (const f of fetches) {
    await f;
  }

  return results;
}

/**
 * Fetch an option chain from Finnhub for a specific underlying and expiration.
 * Uses caching to avoid redundant API calls.
 */
async function fetchOptionChain(
  underlying: string,
  expiry: string
): Promise<FinnhubOptionChainExpiry | null> {
  const cacheKey = `chain:${underlying}:${expiry}`;

  // Check primary cache
  const cached = optionChainCache.get<FinnhubOptionChainExpiry>(cacheKey);
  if (cached) return cached;

  // Check backup cache
  const backup = optionBackupCache.get<FinnhubOptionChainExpiry>(cacheKey);

  try {
    // Finnhub expects expiration in YYYY-MM-DD format
    const response = await finnhubQueue.request<FinnhubOptionChainResponse>(
      '/stock/option/chain',
      { symbol: underlying, expiration: expiry }
    );

    if (!response.data || response.data.length === 0) {
      return backup ?? null;
    }

    // Find the matching expiry in the response
    const match = response.data.find(d => d.expirationDate === expiry);
    if (!match) {
      return backup ?? null;
    }

    // Cache in both layers
    optionChainCache.set(cacheKey, match);
    optionBackupCache.set(cacheKey, match);

    return match;
  } catch {
    // On failure, return backup cache if available
    return backup ?? null;
  }
}

/**
 * Find a specific contract in a chain by strike and type.
 */
function findContract(
  chain: FinnhubOptionChainExpiry,
  strike: number,
  type: 'call' | 'put'
): FinnhubOptionContract | null {
  const contracts = type === 'call' ? chain.options.CALL : chain.options.PUT;
  if (!contracts) return null;

  // Strikes might have floating point differences, match within $0.01
  return contracts.find(c => Math.abs(c.strike - strike) < 0.01) ?? null;
}
