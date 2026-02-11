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

  it('skips invalid rows with warnings', () => {
    const text = `
    AAPL 10
    BADTICKER 5 100
    `;

    const result = parseHoldingsFromText(text);
    expect(result.parsed).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
