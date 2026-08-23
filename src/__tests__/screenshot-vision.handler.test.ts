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

// A real, decodable 1x1 PNG.
//
// This used to be the PNG magic bytes followed by 16 zero bytes — enough to pass
// the magic-byte gate, but not an actual image. The handler now also reads the
// image header to reject decompression bombs (L-7: the 10MB multer cap bounds
// bytes, not pixels), and a fake buffer has no readable header, so it was
// rejected with 400. Using a genuine PNG keeps these tests exercising the real
// decode path rather than asserting against an input that could never occur.
const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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
