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
});
