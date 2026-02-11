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
    const lower = line.toLowerCase();
    if (lower.includes('symbol') && lower.includes('shares')) {
      return;
    }
    const tickerMatches = Array.from(line.matchAll(/\b[A-Z]{1,5}\b/g));
    if (tickerMatches.length === 0) return;

    let ticker = '';
    for (const match of tickerMatches) {
      const candidate = match[0].toUpperCase();
      const idx = match.index ?? 0;
      const beforeChar = idx > 0 ? line[idx - 1] : '';
      if (beforeChar === '&' || beforeChar === '/' || beforeChar === '.') {
        continue;
      }
      if (candidate.length === 1 && line.includes('S&P')) {
        continue;
      }
      const after = line.slice(idx + candidate.length);
      if (/^\s*[\d.]/.test(after)) {
        ticker = candidate;
        break;
      }
    }

    if (!ticker) {
      ticker = tickerMatches[tickerMatches.length - 1][0].toUpperCase();
    }

    if (!isValidTicker(ticker)) {
      warnings.push({ rowNumber, message: 'Invalid ticker format' });
      return;
    }

    const afterTicker = line.slice(line.indexOf(ticker) + ticker.length);
    const dollarMatches = afterTicker.match(/\$[\d,]+(\.\d+)?/g) || [];
    const dollarValues = dollarMatches
      .map(v => parseNumber(v))
      .filter((n): n is number => n !== null);

    const allNums = (afterTicker.match(/[-+]?\d[\d,]*\.?\d*/g) || [])
      .map(n => parseNumber(n))
      .filter((n): n is number => n !== null);

    let shares = allNums[0];
    let averageCost = dollarValues.length >= 2 ? dollarValues[1] : (dollarValues[0] ?? allNums[1]);

    if (lower.includes('avg') || lower.includes('average') || lower.includes('cost')) {
      const avgIdx = lower.search(/avg|average|cost|basis/);
      if (avgIdx >= 0) {
        const after = line.slice(avgIdx);
        const afterNums = (after.match(/[-+]?\d[\d,]*\.?\d*/g) || [])
          .map(n => parseNumber(n))
          .filter((n): n is number => n !== null);
        if (afterNums.length > 0) {
          averageCost = afterNums[0];
        }
      }
    }

    if (shares == null || averageCost == null) {
      warnings.push({ rowNumber, message: 'Not enough numeric values found' });
      return;
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
      confidence: dollarValues.length >= 2 ? 'high' : 'medium',
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
