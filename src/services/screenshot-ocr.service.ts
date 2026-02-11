import { createWorker } from 'tesseract.js';

export interface OcrParsedRow {
  rowNumber: number;
  ticker: string;
  shares: number;
  averageCost: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface OcrParseResult {
  parsed: OcrParsedRow[];
  warnings: { rowNumber: number; message: string }[];
}

function parseNumber(value: string): number | null {
  const cleaned = value.replace(/[$,]/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function isValidTicker(ticker: string): boolean {
  return /^[A-Z]{1,5}$/.test(ticker);
}

export function parseHoldingsFromText(text: string): OcrParseResult {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const parsed: OcrParsedRow[] = [];
  const warnings: { rowNumber: number; message: string }[] = [];

  lines.forEach((line, idx) => {
    const rowNumber = idx + 1;
    const tickerMatch = line.match(/\b[A-Z]{1,5}\b/);
    if (!tickerMatch) {
      return;
    }
    const ticker = tickerMatch[0].toUpperCase();
    if (!isValidTicker(ticker)) {
      warnings.push({ rowNumber, message: 'Invalid ticker format' });
      return;
    }

    const nums = (line.match(/[-+]?\d[\d,]*\.?\d*/g) || [])
      .map(n => parseNumber(n))
      .filter((n): n is number => n !== null);

    if (nums.length < 2) {
      warnings.push({ rowNumber, message: 'Not enough numeric values found' });
      return;
    }

    let shares = nums[0];
    let averageCost = nums[1];

    const lower = line.toLowerCase();
    const avgIdx = lower.search(/avg|average|cost|basis/);
    if (avgIdx >= 0) {
      const after = line.slice(avgIdx);
      const afterNums = (after.match(/[-+]?\d[\d,]*\.?\d*/g) || [])
        .map(n => parseNumber(n))
        .filter((n): n is number => n !== null);
      if (afterNums.length > 0) {
        averageCost = afterNums[0];
        const remaining = nums.filter(n => n !== averageCost);
        if (remaining.length > 0) shares = remaining[0];
      }
    }

    if (shares <= 0 || averageCost < 0) {
      warnings.push({ rowNumber, message: 'Invalid shares or average cost' });
      return;
    }

    parsed.push({
      rowNumber,
      ticker,
      shares,
      averageCost,
      confidence: 'medium',
    });
  });

  return { parsed, warnings };
}

export async function extractTextFromImage(buffer: Buffer): Promise<{ text: string; confidence: number }> {
  const worker = await createWorker('eng');
  try {
    const { data } = await worker.recognize(buffer);
    return { text: data.text || '', confidence: data.confidence ?? 0 };
  } finally {
    await worker.terminate();
  }
}
