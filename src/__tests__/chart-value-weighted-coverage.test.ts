import { describe, it, expect } from 'vitest';

/**
 * Extracted coverage logic matching reconstructPortfolioHistoryFromTrades.
 * Value-weighted: 80% of portfolio VALUE (not ticker count) must have price data.
 */
function computeCoverage(
  holdings: { ticker: string; shares: number }[],
  priceMap: Map<string, number>,         // ticker -> price (null if missing)
  firstPrices: Map<string, number>,      // forward-fill prices
  tickerAvgPrices: Map<string, number>,  // fallback from avg trade prices
): { coveredValue: number; missingValue: number; ratio: number; included: boolean } {
  let coveredValue = 0;
  let missingValue = 0;

  for (const { ticker, shares } of holdings) {
    const price = priceMap.get(ticker);
    if (price != null) {
      coveredValue += shares * price;
    } else {
      const firstPrice = firstPrices.get(ticker);
      if (firstPrice !== undefined) {
        coveredValue += shares * firstPrice;
      } else {
        const avgPrice = tickerAvgPrices.get(ticker) || 0;
        missingValue += shares * avgPrice;
      }
    }
  }

  const estimatedTotal = coveredValue + missingValue;
  const ratio = estimatedTotal > 0 ? coveredValue / estimatedTotal : 0;
  const included = estimatedTotal > 0 && ratio >= 0.8;

  return { coveredValue, missingValue, ratio, included };
}

describe('Value-weighted coverage', () => {
  it('includes point when all tickers have prices (100% coverage)', () => {
    const holdings = [
      { ticker: 'AAPL', shares: 100 },
      { ticker: 'MSFT', shares: 50 },
      { ticker: 'AMZN', shares: 30 },
    ];
    const priceMap = new Map([['AAPL', 210], ['MSFT', 420], ['AMZN', 200]]);

    const result = computeCoverage(holdings, priceMap, new Map(), new Map());

    expect(result.ratio).toBe(1.0);
    expect(result.included).toBe(true);
    expect(result.missingValue).toBe(0);
  });

  it('excludes point when major holding (60% of value) has no price data', () => {
    // AAPL: $20k, MSFT: $20k, AMZN: $60k (60% of portfolio)
    const holdings = [
      { ticker: 'AAPL', shares: 100 },
      { ticker: 'MSFT', shares: 100 },
      { ticker: 'AMZN', shares: 300 },
    ];
    const priceMap = new Map([['AAPL', 200], ['MSFT', 200]]);
    // AMZN has no candle, no forward-fill, but has avg trade price
    const tickerAvgPrices = new Map([['AMZN', 200]]);

    const result = computeCoverage(holdings, priceMap, new Map(), tickerAvgPrices);

    // covered = $40k, missing = $60k, ratio = 40/100 = 0.40
    expect(result.coveredValue).toBe(40000);
    expect(result.missingValue).toBe(60000);
    expect(result.ratio).toBeCloseTo(0.4, 2);
    expect(result.included).toBe(false);
  });

  it('includes point when only small holding (5% of value) is missing', () => {
    // AAPL: $95k, PENNY: $5k
    const holdings = [
      { ticker: 'AAPL', shares: 100 },
      { ticker: 'PENNY', shares: 500 },
    ];
    const priceMap = new Map([['AAPL', 950]]);
    const tickerAvgPrices = new Map([['PENNY', 10]]);

    const result = computeCoverage(holdings, priceMap, new Map(), tickerAvgPrices);

    // covered = $95k, missing = $5k, ratio = 95/100 = 0.95
    expect(result.ratio).toBeCloseTo(0.95, 2);
    expect(result.included).toBe(true);
  });

  it('differs from count-based: 1 of 2 tickers missing but small value = included', () => {
    // Count-based: 1/2 = 50% -> excluded (needs 80%)
    // Value-weighted: $100 of $10100 = 0.99% missing -> included
    const holdings = [
      { ticker: 'AAPL', shares: 100 },  // $10k
      { ticker: 'PENNY', shares: 1 },    // $1
    ];
    const priceMap = new Map([['AAPL', 100]]);
    const tickerAvgPrices = new Map([['PENNY', 1]]);

    const result = computeCoverage(holdings, priceMap, new Map(), tickerAvgPrices);

    // Count-based would say 1/2 = 50% < 80% = excluded
    // Value-weighted says $10000/$10001 = 99.99% >= 80% = included
    expect(result.ratio).toBeGreaterThan(0.99);
    expect(result.included).toBe(true);
  });

  it('uses forward-fill price as covered (not missing)', () => {
    const holdings = [
      { ticker: 'AAPL', shares: 100 },
      { ticker: 'NEWIPO', shares: 50 },
    ];
    const priceMap = new Map([['AAPL', 200]]);
    // NEWIPO has forward-fill but no price at this specific date
    const firstPrices = new Map([['NEWIPO', 100]]);

    const result = computeCoverage(holdings, priceMap, firstPrices, new Map());

    // Both covered: AAPL=$20k (candle), NEWIPO=$5k (forward-fill)
    expect(result.coveredValue).toBe(25000);
    expect(result.missingValue).toBe(0);
    expect(result.ratio).toBe(1.0);
    expect(result.included).toBe(true);
  });

  it('handles ticker with no price info at all (avgPrice=0)', () => {
    const holdings = [
      { ticker: 'AAPL', shares: 100 },
      { ticker: 'MYSTERY', shares: 50 },
    ];
    const priceMap = new Map([['AAPL', 200]]);
    // MYSTERY has no candle, no forward-fill, no avg trade price

    const result = computeCoverage(holdings, priceMap, new Map(), new Map());

    // missingValue = 50 * 0 = 0, so estimatedTotal = coveredValue only
    // ratio = 20000/20000 = 1.0 (the unknown ticker contributes 0 to total)
    expect(result.coveredValue).toBe(20000);
    expect(result.missingValue).toBe(0);
    expect(result.included).toBe(true);
  });

  it('boundary: exactly 80% coverage includes the point', () => {
    // Engineered: covered=$80, missing=$20
    const holdings = [
      { ticker: 'A', shares: 80 },
      { ticker: 'B', shares: 20 },
    ];
    const priceMap = new Map([['A', 1]]);
    const tickerAvgPrices = new Map([['B', 1]]);

    const result = computeCoverage(holdings, priceMap, new Map(), tickerAvgPrices);

    expect(result.ratio).toBeCloseTo(0.8, 6);
    expect(result.included).toBe(true);
  });

  it('boundary: 79.9% coverage excludes the point', () => {
    const holdings = [
      { ticker: 'A', shares: 799 },
      { ticker: 'B', shares: 201 },
    ];
    const priceMap = new Map([['A', 1]]);
    const tickerAvgPrices = new Map([['B', 1]]);

    const result = computeCoverage(holdings, priceMap, new Map(), tickerAvgPrices);

    expect(result.ratio).toBeLessThan(0.8);
    expect(result.included).toBe(false);
  });
});
