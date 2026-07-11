import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

import { extractHoldingsWithVision, visionExtractionAvailable } from '../services/screenshot-vision.service';

function visionResponse(holdings: unknown, stopReason = 'end_turn') {
  return {
    stop_reason: stopReason,
    content: [{ type: 'text', text: JSON.stringify({ holdings }) }],
  };
}

const PNG = Buffer.from('fake-image');

describe('screenshot-vision.service', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_VISION_MODEL;
  });

  it('maps model holdings to parsed rows with sequential rowNumbers', async () => {
    mockCreate.mockResolvedValue(visionResponse([
      { ticker: 'aapl', shares: 10.5, averageCost: 150.25, confidence: 'high', usedPriceProxy: false },
      { ticker: 'MSFT', shares: 3, averageCost: 410, confidence: 'medium', usedPriceProxy: false },
    ]));

    const result = await extractHoldingsWithVision(PNG, 'image/png');

    expect(result.parsed).toEqual([
      { rowNumber: 1, ticker: 'AAPL', shares: 10.5, averageCost: 150.25, confidence: 'high' },
      { rowNumber: 2, ticker: 'MSFT', shares: 3, averageCost: 410, confidence: 'medium' },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.skippedCount).toBe(0);
    expect(result.model).toBe('claude-opus-4-8');
  });

  it('supports dotted share-class tickers (BRK.B)', async () => {
    mockCreate.mockResolvedValue(visionResponse([
      { ticker: 'BRK.B', shares: 2, averageCost: 415.5, confidence: 'high', usedPriceProxy: false },
    ]));

    const result = await extractHoldingsWithVision(PNG, 'image/png');
    expect(result.parsed[0].ticker).toBe('BRK.B');
  });

  it('skips invalid tickers and out-of-bounds numbers with warnings', async () => {
    mockCreate.mockResolvedValue(visionResponse([
      { ticker: 'TOOLONGX', shares: 1, averageCost: 1, confidence: 'high', usedPriceProxy: false },
      { ticker: 'AAPL', shares: 1e12, averageCost: 1, confidence: 'high', usedPriceProxy: false },
      { ticker: 'MSFT', shares: 1, averageCost: -5, confidence: 'high', usedPriceProxy: false },
      { ticker: 'NVDA', shares: 4, averageCost: 880, confidence: 'high', usedPriceProxy: false },
    ]));

    const result = await extractHoldingsWithVision(PNG, 'image/png');

    expect(result.parsed).toHaveLength(1);
    expect(result.parsed[0]).toMatchObject({ rowNumber: 4, ticker: 'NVDA' });
    expect(result.skippedCount).toBe(3);
    expect(result.warnings).toHaveLength(3);
  });

  it('flags price-proxy rows as low confidence with a warning', async () => {
    mockCreate.mockResolvedValue(visionResponse([
      { ticker: 'TSLA', shares: 5, averageCost: 250, confidence: 'high', usedPriceProxy: true },
    ]));

    const result = await extractHoldingsWithVision(PNG, 'image/png');

    expect(result.parsed[0].confidence).toBe('low');
    expect(result.warnings).toEqual([
      { rowNumber: 1, message: 'Average cost not found; used price as proxy' },
    ]);
    expect(result.skippedCount).toBe(0);
  });

  it('throws on refusal stop reason', async () => {
    mockCreate.mockResolvedValue({ stop_reason: 'refusal', content: [] });
    await expect(extractHoldingsWithVision(PNG, 'image/png')).rejects.toThrow('refused');
  });

  it('throws on unparseable output', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'not json' }],
    });
    await expect(extractHoldingsWithVision(PNG, 'image/png')).rejects.toThrow('unparseable');
  });

  it('honors the ANTHROPIC_VISION_MODEL override', async () => {
    process.env.ANTHROPIC_VISION_MODEL = 'claude-haiku-4-5';
    mockCreate.mockResolvedValue(visionResponse([]));

    const result = await extractHoldingsWithVision(PNG, 'image/png');

    expect(result.model).toBe('claude-haiku-4-5');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-haiku-4-5' }));
  });

  it('visionExtractionAvailable reflects the API key env', () => {
    expect(visionExtractionAvailable()).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
    expect(visionExtractionAvailable()).toBe(false);
  });
});
