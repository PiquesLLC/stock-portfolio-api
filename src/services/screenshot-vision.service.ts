import Anthropic from '@anthropic-ai/sdk';
import type { OcrParsedRow, OcrParseResult } from './screenshot-ocr.service';

// Claude-vision extraction of holdings from brokerage screenshots. Replaces
// the tesseract heuristics as the primary engine (any broker layout, any
// theme, ticker inference from company names); the OCR path remains the
// fallback when ANTHROPIC_API_KEY is absent or the API call fails.

const DEFAULT_VISION_MODEL = 'claude-opus-4-8';

// Mirrors the confirm endpoint's validator (dots allowed: BRK.B) — the OCR
// parser's stricter no-dot regex was a known gap.
const TICKER_RE = /^[A-Z]{1,5}(\.[A-Z])?$/;
const MAX_SHARES = 1e9;
const MAX_PRICE = 1e7;

export function visionExtractionAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

interface VisionHolding {
  ticker: string;
  shares: number;
  averageCost: number;
  confidence: 'high' | 'medium' | 'low';
  usedPriceProxy: boolean;
}

// Structured-outputs schema: the API guarantees the response text parses as
// JSON matching this shape, so downstream handling is mapping + bounds
// checks, not defensive parsing. (Numeric min/max constraints aren't
// supported by structured outputs — enforced in code below.)
const HOLDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['holdings'],
  properties: {
    holdings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ticker', 'shares', 'averageCost', 'confidence', 'usedPriceProxy'],
        properties: {
          ticker: {
            type: 'string',
            description: 'US exchange ticker symbol, uppercase (e.g. AAPL, BRK.B). When the screenshot shows a company name instead of a symbol, infer the ticker.',
          },
          shares: { type: 'number', description: 'Number of shares held. May be fractional.' },
          averageCost: { type: 'number', description: 'Average cost paid PER SHARE in USD.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          usedPriceProxy: {
            type: 'boolean',
            description: 'True when no average-cost figure was visible and the current/last price was used as a stand-in.',
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You extract stock holdings from brokerage app screenshots (Robinhood, Webull, Fidelity, Schwab, etc., any theme).

Rules:
- Extract ONLY actual portfolio positions. Skip watchlist entries, market indices (S&P 500, DOW, NASDAQ), cash/buying-power rows, account totals, news, ads, and navigation chrome.
- Stocks and ETFs only — skip cryptocurrencies and options rows.
- averageCost is the average price PAID per share. Prefer explicit "avg cost" / "average price" / "cost basis per share" figures. If a TOTAL cost basis and share count are shown, divide. If only the current/last market price is visible, use it and set usedPriceProxy=true. NEVER use total market value as a per-share cost.
- Tickers: use the symbol when visible (confidence "high" if all numbers are also clear). When only a company name is shown, infer the ticker and cap confidence at "medium". If you cannot confidently identify the ticker, omit the row.
- Numbers may contain $ signs, commas, or unit suffixes — return plain numbers.
- If the image is not a portfolio/holdings screenshot, return an empty holdings array.`;

export interface VisionExtractionResult extends OcrParseResult {
  model: string;
  skippedCount: number;
}

export async function extractHoldingsWithVision(
  buffer: Buffer,
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp',
): Promise<VisionExtractionResult> {
  const model = process.env.ANTHROPIC_VISION_MODEL || DEFAULT_VISION_MODEL;
  // Lazy construction: reads ANTHROPIC_API_KEY at call time (also keeps tests
  // free to toggle the env per case). Tight timeout — this runs inside a user
  // upload request; the SDK retries once on transient failures.
  const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });

  const response = await client.messages.create({
    model,
    // Thinking shares this budget — dense screenshots need headroom or the
    // JSON truncates and we needlessly fall back to OCR. Medium effort: a
    // bounded extraction task inside a user upload; high-effort deliberation
    // only adds latency against the 60s timeout.
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: HOLDINGS_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') },
          },
          { type: 'text', text: 'Extract every stock holding visible in this screenshot.' },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Vision extraction refused');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Vision extraction truncated');
  }

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text' || !textBlock.text) {
    throw new Error('Vision extraction returned no output');
  }

  let holdings: VisionHolding[];
  try {
    const parsedJson = JSON.parse(textBlock.text) as { holdings?: VisionHolding[] };
    holdings = Array.isArray(parsedJson.holdings) ? parsedJson.holdings : [];
  } catch {
    throw new Error('Vision extraction returned unparseable output');
  }

  const parsed: OcrParsedRow[] = [];
  const warnings: OcrParseResult['warnings'] = [];
  let skippedCount = 0;

  holdings.forEach((h, idx) => {
    const rowNumber = idx + 1;
    const ticker = String(h.ticker || '').trim().toUpperCase();
    const shares = Number(h.shares);
    const averageCost = Number(h.averageCost);

    if (!TICKER_RE.test(ticker)) {
      skippedCount += 1;
      warnings.push({ rowNumber, message: `Unrecognized ticker '${ticker || '?'}' skipped` });
      return;
    }
    if (
      !Number.isFinite(shares) || shares <= 0 || shares > MAX_SHARES ||
      !Number.isFinite(averageCost) || averageCost < 0 || averageCost > MAX_PRICE
    ) {
      skippedCount += 1;
      warnings.push({ rowNumber, message: `Invalid shares or average cost for ${ticker}` });
      return;
    }

    const usedPriceProxy = h.usedPriceProxy === true;
    const confidence: OcrParsedRow['confidence'] = usedPriceProxy
      ? 'low'
      : h.confidence === 'high' || h.confidence === 'medium' || h.confidence === 'low'
        ? h.confidence
        : 'medium';

    if (usedPriceProxy) {
      warnings.push({ rowNumber, message: 'Average cost not found; used price as proxy' });
    }

    parsed.push({ rowNumber, ticker, shares, averageCost, confidence });
  });

  return { parsed, warnings, model, skippedCount };
}
