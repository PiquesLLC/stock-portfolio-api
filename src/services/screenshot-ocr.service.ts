import { createWorker } from 'tesseract.js';
import sharp from 'sharp';

export interface OcrParsedRow {
  rowNumber: number;
  ticker: string;
  shares: number;
  averageCost: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface OcrParseResult {
  parsed: OcrParsedRow[];
  warnings: { rowNumber: number; message: string; line?: string }[];
}

function isHeic(mimeType?: string | null, fileName?: string | null): boolean {
  if (mimeType) {
    const normalized = mimeType.toLowerCase();
    if (normalized === 'image/heic' || normalized === 'image/heif') {
      return true;
    }
  }
  if (fileName) {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.heic') || lower.endsWith('.heif')) {
      return true;
    }
  }
  return false;
}

async function maybeConvertHeicToPng(
  buffer: Buffer,
  options?: { mimeType?: string | null; fileName?: string | null }
): Promise<Buffer> {
  if (!isHeic(options?.mimeType, options?.fileName)) {
    return buffer;
  }
  try {
    return await sharp(buffer).png().toBuffer();
  } catch (error) {
    const err = error as Error;
    throw new Error(`HEIC conversion failed: ${err.message}`);
  }
}

async function preprocessForOcr(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer)
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();
  } catch {
    return buffer;
  }
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

function extractSharesAndAvgCost(line: string): { shares: number | null; averageCost: number | null } {
  const lower = line.toLowerCase();
  const sharesMatch = lower.match(/([\d.,]+)\s*shares/);
  const shares = sharesMatch ? parseNumber(sharesMatch[1]) : null;

  let averageCost: number | null = null;
  const avgIdx = lower.search(/avg|average|cost/);
  const dollarMatches = Array.from(line.matchAll(/\$[\d,]+(\.\d+)?/g));
  if (avgIdx >= 0 && dollarMatches.length > 0) {
    let bestValue: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const match of dollarMatches) {
      const idx = match.index ?? 0;
      const distance = Math.abs(idx - avgIdx);
      const value = parseNumber(match[0]);
      if (value != null && distance < bestDistance) {
        bestDistance = distance;
        bestValue = value;
      }
    }
    averageCost = bestValue;
  } else {
    const avgMatch = lower.match(/avg\.?\s*cost[^$]*\$?([\d.,]+)/);
    if (avgMatch) {
      averageCost = parseNumber(avgMatch[1]);
    }
  }

  if (averageCost == null && (lower.includes('avg') || lower.includes('average') || lower.includes('cost'))) {
    const nums = (line.match(/[-+]?\d[\d,]*\.?\d*/g) || [])
      .map(n => parseNumber(n))
      .filter((n): n is number => n !== null);
    averageCost = nums.length > 0 ? nums[nums.length - 1] : null;
  }

  return { shares, averageCost };
}

export function parseHoldingsFromText(text: string): OcrParseResult {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const parsed: OcrParsedRow[] = [];
  const warnings: { rowNumber: number; message: string; line?: string }[] = [];

  let headerHasPrice = false;
  let headerHasAvgCost = false;
  lines.forEach(line => {
    const lower = line.toLowerCase();
    if (lower.includes('symbol') || lower.includes('shares') || lower.includes('quantity')) {
      if (lower.includes('price')) headerHasPrice = true;
      if (lower.includes('avg') || lower.includes('average') || lower.includes('cost basis') || lower.includes('cost')) {
        headerHasAvgCost = true;
      }
    }
  });

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const rowNumber = idx + 1;
    const lower = line.toLowerCase();
    if (lower.includes('symbol') && (lower.includes('shares') || lower.includes('quantity'))) {
      continue;
    }
    const tickerMatches = Array.from(line.matchAll(/\b[A-Z]{1,5}\b/g));
    if (tickerMatches.length === 0) continue;

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
      if (/^\s*[\d.$]/.test(after)) {
        ticker = candidate;
        break;
      }
    }

    if (!ticker) {
      ticker = tickerMatches[tickerMatches.length - 1][0].toUpperCase();
    }

    if (!isValidTicker(ticker)) {
      warnings.push({ rowNumber, message: 'Invalid ticker format', line });
      continue;
    }

    const hasDollar = line.includes('$');
    const hasAvgHint = lower.includes('avg') || lower.includes('average') || lower.includes('cost');
    const nextLine = lines[idx + 1];
    const nextLower = nextLine ? nextLine.toLowerCase() : '';
    const nextHasShares = nextLower.includes('shares');
    const nextHasAvgHint = nextLower.includes('avg') || nextLower.includes('average') || nextLower.includes('cost');
    const afterTickerRaw = line.slice(line.indexOf(ticker) + ticker.length);
    const simpleNumericTail = /^[\s\d.,$]+$/.test(afterTickerRaw);
    const numericCount = (afterTickerRaw.match(/[-+]?\d[\d,]*\.?\d*/g) || []).length;

    // If there's no clear numeric context (no $ and no shares/avg cost on this or next line), skip.
    if (
      !hasDollar &&
      !hasAvgHint &&
      !(nextHasShares && nextHasAvgHint) &&
      !(simpleNumericTail && numericCount >= 2)
    ) {
      warnings.push({ rowNumber, message: 'Not enough numeric values found', line });
      continue;
    }

    if (nextLine) {
      if (nextHasShares && nextHasAvgHint) {
        const { shares, averageCost } = extractSharesAndAvgCost(nextLine);
        if (shares != null && averageCost != null && shares > 0 && averageCost >= 0) {
          parsed.push({
            rowNumber,
            ticker,
            shares,
            averageCost,
            confidence: 'medium',
          });
          idx += 1;
          continue;
        }
      }
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
    let averageCost: number | null = null;
    let usedPriceAsAverage = false;

    const priceCandidate = (() => {
      if (shares == null || dollarValues.length === 0) return null;
      let best: number | null = null;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const candidate of dollarValues) {
        const target = candidate * shares;
        for (const other of dollarValues) {
          if (other === candidate) continue;
          const delta = Math.abs(other - target);
          if (delta < bestDelta) {
            bestDelta = delta;
            best = candidate;
          }
        }
      }
      return best;
    })();

    if (headerHasAvgCost) {
      if (dollarValues.length >= 2) {
        if (priceCandidate != null) {
          const perShareCandidates = dollarValues.filter(v => v !== priceCandidate);
          const closest = perShareCandidates.reduce<number | null>((best, v) => {
            if (best == null) return v;
            return Math.abs(v - priceCandidate) < Math.abs(best - priceCandidate) ? v : best;
          }, null);
          averageCost = closest ?? dollarValues[1];
        } else {
          averageCost = dollarValues[1];
        }
      } else {
        averageCost = dollarValues[0] ?? allNums[1] ?? null;
      }
    } else {
      averageCost = dollarValues.length >= 2 ? dollarValues[1] : (dollarValues[0] ?? allNums[1] ?? null);
    }

    if (headerHasPrice && priceCandidate != null) {
      if (averageCost == null) {
        averageCost = priceCandidate;
        usedPriceAsAverage = true;
      } else if (!headerHasAvgCost && dollarValues.length <= 2 && averageCost === priceCandidate) {
        usedPriceAsAverage = true;
      }
    }

    if (shares == null || averageCost == null) {
      warnings.push({ rowNumber, message: 'Not enough numeric values found', line });
      continue;
    }

    if (shares <= 0 || averageCost < 0) {
      warnings.push({ rowNumber, message: 'Invalid shares or average cost', line });
      continue;
    }

    parsed.push({
      rowNumber,
      ticker,
      shares,
      averageCost,
      confidence: usedPriceAsAverage ? 'low' : (dollarValues.length >= 2 ? 'high' : 'medium'),
    });

    if (usedPriceAsAverage) {
      warnings.push({ rowNumber, message: 'Average cost not found; used price as proxy', line });
    }
  }

  return { parsed, warnings };
}

export async function extractTextFromImage(
  buffer: Buffer,
  options?: { mimeType?: string | null; fileName?: string | null }
): Promise<{ text: string; confidence: number }> {
  const inputBuffer = await maybeConvertHeicToPng(buffer, options);
  const preprocessed = await preprocessForOcr(inputBuffer);
  const worker = await createWorker('eng');
  try {
    const { data } = await worker.recognize(preprocessed);
    return { text: data.text || '', confidence: data.confidence ?? 0 };
  } finally {
    await worker.terminate();
  }
}
