import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/screenshot-vision.service', () => ({
  visionExtractionAvailable: vi.fn(),
  extractHoldingsWithVision: vi.fn(),
}));
vi.mock('../services/screenshot-ocr.service', () => ({
  extractBestOcrForHoldings: vi.fn(),
  parseHoldingsFromText: vi.fn(),
}));

import app from '../app';
import { generateTestToken, testUser } from './helpers';
import { visionExtractionAvailable, extractHoldingsWithVision } from '../services/screenshot-vision.service';
import { extractBestOcrForHoldings } from '../services/screenshot-ocr.service';

function authHeader() {
  return { Authorization: `Bearer ${generateTestToken(testUser)}` };
}

// Minimal buffer passing the handler's PNG magic-byte gate
const PNG_BUFFER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);

const VISION_ROWS = [
  { rowNumber: 1, ticker: 'AAPL', shares: 10, averageCost: 150, confidence: 'high' as const },
];
const OCR_ROWS = [
  { rowNumber: 1, ticker: 'MSFT', shares: 5, averageCost: 400, confidence: 'high' as const },
];

describe('POST /portfolio/import/screenshot — engine selection', () => {
  beforeEach(() => {
    vi.mocked(visionExtractionAvailable).mockReset();
    vi.mocked(extractHoldingsWithVision).mockReset();
    vi.mocked(extractBestOcrForHoldings).mockReset();
    vi.mocked(extractBestOcrForHoldings).mockResolvedValue({
      text: 'MSFT 5 $400',
      confidence: 90,
      variant: 'original',
      parsed: { parsed: OCR_ROWS, warnings: [] },
    });
  });

  it('uses vision when an API key is configured', async () => {
    vi.mocked(visionExtractionAvailable).mockReturnValue(true);
    vi.mocked(extractHoldingsWithVision).mockResolvedValue({
      parsed: VISION_ROWS,
      warnings: [],
      model: 'claude-opus-4-8',
      skippedCount: 0,
    });

    const res = await request(app)
      .post('/portfolio/import/screenshot')
      .set(authHeader())
      .attach('file', PNG_BUFFER, { filename: 'shot.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.parsed).toEqual(VISION_ROWS);
    expect(res.body.validRows).toBe(1);
    expect(extractHoldingsWithVision).toHaveBeenCalledWith(expect.any(Buffer), 'image/png');
    expect(extractBestOcrForHoldings).not.toHaveBeenCalled();
  });

  it('falls back to OCR when vision extraction throws', async () => {
    vi.mocked(visionExtractionAvailable).mockReturnValue(true);
    vi.mocked(extractHoldingsWithVision).mockRejectedValue(new Error('Vision extraction refused'));

    const res = await request(app)
      .post('/portfolio/import/screenshot')
      .set(authHeader())
      .attach('file', PNG_BUFFER, { filename: 'shot.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.parsed).toEqual(OCR_ROWS);
    expect(extractBestOcrForHoldings).toHaveBeenCalled();
  });

  it('uses OCR directly when no API key is configured', async () => {
    vi.mocked(visionExtractionAvailable).mockReturnValue(false);

    const res = await request(app)
      .post('/portfolio/import/screenshot')
      .set(authHeader())
      .attach('file', PNG_BUFFER, { filename: 'shot.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.parsed).toEqual(OCR_ROWS);
    expect(extractHoldingsWithVision).not.toHaveBeenCalled();
  });
});
