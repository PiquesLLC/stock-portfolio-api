import { describe, it, expect } from 'vitest';
import { parseHoldingsFromText } from '../services/screenshot-ocr.service';

describe('Screenshot OCR parsing', () => {
  it('parses tickers with shares and average cost', () => {
    const text = `
    AAPL 10 150.25
    MSFT 5 320
    `;

    const result = parseHoldingsFromText(text);
    expect(result.parsed).toHaveLength(2);
    expect(result.parsed[0]).toMatchObject({ ticker: 'AAPL', shares: 10, averageCost: 150.25 });
  });

  it('parses table rows with prices and average cost', () => {
    const text = `
    SPDR S&P 500 ETF Trust SPY 285.211 $692.20 $545.70 $41,783.54 $197,423.26
    Alphabet Class A GOOGL 200 $311.74 $191.21 $24,105.90 $62,348.00
    `;

    const result = parseHoldingsFromText(text);
    expect(result.parsed).toHaveLength(2);
    expect(result.parsed[0]).toMatchObject({ ticker: 'SPY', shares: 285.211, averageCost: 545.70 });
    expect(result.parsed[1]).toMatchObject({ ticker: 'GOOGL', shares: 200, averageCost: 191.21 });
  });

  it('skips invalid rows with warnings', () => {
    const text = `
    AAPL 10
    BADTICKER 5 100
    `;

    const result = parseHoldingsFromText(text);
    expect(result.parsed).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('uses price as average cost when only price is available', () => {
    const text = `
    Symbol Quantity Market Value Price
    PG 27.3593 $2,512.40 $91.83
    `;

    const result = parseHoldingsFromText(text);
    expect(result.parsed).toHaveLength(1);
    expect(result.parsed[0]).toMatchObject({ ticker: 'PG', shares: 27.3593, averageCost: 91.83 });
    expect(result.warnings.some(w => w.message.includes('Average cost not found'))).toBe(true);
  });

  it('parses two-line mobile rows with shares and avg cost', () => {
    const text = `
    AAPL $1,956.91
    11.328 shares | $156.07 avg. cost
    `;

    const result = parseHoldingsFromText(text);
    expect(result.parsed).toHaveLength(1);
    expect(result.parsed[0]).toMatchObject({ ticker: 'AAPL', shares: 11.328, averageCost: 156.07 });
  });

  it('skips ticker-like noise without shares or prices', () => {
    const text = `
    0556 e@BU@ WAN a 16%8
    Assets P&L Orders(0)
    `;

    const result = parseHoldingsFromText(text);
    expect(result.parsed).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('parses ticker lines that start with a ticker and two numbers', () => {
    const text = `
    MULN 25 esal% 50.1091
    BAC 5 ; s28.5¢
    `;

    const result = parseHoldingsFromText(text);
    expect(result.parsed).toHaveLength(2);
    expect(result.parsed[0]).toMatchObject({ ticker: 'MULN', shares: 25, averageCost: 50.1091 });
    expect(result.parsed[1]).toMatchObject({ ticker: 'BAC', shares: 5, averageCost: 28.5 });
  });

  it('uses previous line price to correct missing decimals', () => {
    const text = `
    Nintendo Co Ltd 48.00 +0.35 9.60
    NTDOY Ss  o7m 5953
    `;

    const result = parseHoldingsFromText(text);
    expect(result.parsed).toHaveLength(1);
    expect(result.parsed[0]).toMatchObject({ ticker: 'NTDOY', shares: 7, averageCost: 9.60 });
  });
});
