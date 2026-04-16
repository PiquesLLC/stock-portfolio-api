import { describe, it, expect } from 'vitest';
import { extractJson } from '../utils/perplexity';

// Reproduces the real-world Gemini deep-research output shape reported for LITE:
// long markdown report with prose, inline [1] citation brackets, and the
// structured payload appended as a fenced ```json {...}``` block at the end.
// Deep-research service does `JSON.parse(extractJson(outputText))`. When that
// throws, parseError is set and the UI shows "Report could not be fully parsed."
//
// These tests pin the behavior we want: extractJson must return a string that
// JSON.parse() accepts for the representative Gemini outputs below.

const LITE_STYLE_OUTPUT = `# Lumentum Holdings Inc. (NASDAQ: LITE): Comprehensive Research

**Key Points:**
*   **Transformational NVIDIA Partnership:** NVIDIA's recent $2 billion strategic investment [cite: 1, 2].
*   **Accelerating Margin Profile:** Q3 FY2026 guidance implies 85% year-over-year revenue growth [cite: 3, 4].
*   **Elevated Valuation Metrics:** At current levels (~$852–$897), Lumentum trades at a steep premium [cite: 5, 6].

## 1. Executive Summary & Portfolio Context

Lumentum Holdings Inc. (NASDAQ: LITE) has emerged as a premier beneficiary of AI infrastructure [cite: 4, 10]. The stock recently reached all-time highs near $960 before consolidating in the $850–$890 range [cite: 11, 12].

| Metric | LITE | COHR |
| :--- | :--- | :--- |
| Forward P/S | ~21.0x | ~7.7x |
| Forward P/E | ~107.0x | ~48.0x |

***

### Requested JSON Output

\`\`\`json
{
  "executiveSummary": "Lumentum has transformed into a critical AI infrastructure play.",
  "bullCase": "NVIDIA's $2B investment anchors long-term revenue visibility.",
  "baseCase": "Hits Q3 FY2026 revenue midpoint of $805M; multiple compresses.",
  "bearCase": "At >90x forward earnings, multiple contraction risk is severe.",
  "keyRisks": [
    "Severe multiple contraction if AI CapEx slows.",
    "Competition from Coherent (COHR) with better vertical integration.",
    "Execution risk ramping the Greensboro fab."
  ],
  "keyCatalysts": [
    "Q3 FY2026 earnings call on May 5, 2026.",
    "200G EML mix reaching 25% by end of 2026."
  ],
  "valuation": {
    "method": "Comparables & Historical Multiple Expansion",
    "comparables": ["COHR", "AAOI", "FN"],
    "summary": "Fair value range $650–$820 vs current $852–$897."
  },
  "citations": [
    {
      "title": "NVIDIA to invest $4B in Lumentum and Coherent",
      "url": "https://compoundsemiconductor.net/article/123669",
      "snippet": "NVIDIA has announced multiyear strategic agreements..."
    },
    {
      "title": "Lumentum Q2 2026 Earnings Call Transcript",
      "url": "https://www.fool.com/earnings/call-transcripts/2026/02/03/",
      "snippet": "Q3 2026 revenue in the range of $780 to $830 million."
    }
  ],
  "confidenceNotes": "High confidence in AI photonics tailwinds. Medium confidence in valuation sustainability."
}
\`\`\`

**Sources:**
1. [compoundsemiconductor.net](https://example.com/1)
2. [fool.com](https://example.com/2)
`;

const TRAILING_FENCE_ONLY = `Some preamble prose that contains a curly brace { like this }
and a square bracket [1] citation, then:

\`\`\`json
{"executiveSummary":"x","bullCase":"y","baseCase":"z","bearCase":"w","keyRisks":[],"keyCatalysts":[],"valuation":{"method":"m","comparables":[],"summary":"s"},"citations":[],"confidenceNotes":"n"}
\`\`\`
`;

const PURE_JSON = `{"executiveSummary":"x","bullCase":"y","baseCase":"z","bearCase":"w","keyRisks":[],"keyCatalysts":[],"valuation":{"method":"m","comparables":[],"summary":"s"},"citations":[],"confidenceNotes":"n"}`;

const PURE_FENCED_JSON = `\`\`\`json
{"executiveSummary":"x","bullCase":"y","baseCase":"z","bearCase":"w","keyRisks":[],"keyCatalysts":[],"valuation":{"method":"m","comparables":[],"summary":"s"},"citations":[],"confidenceNotes":"n"}
\`\`\``;

describe('extractJson — deep research parser contract', () => {
  it('parses pure JSON output (baseline)', () => {
    const extracted = extractJson(PURE_JSON);
    expect(() => JSON.parse(extracted)).not.toThrow();
    const parsed = JSON.parse(extracted);
    expect(parsed.executiveSummary).toBe('x');
  });

  it('parses pure fenced ```json block (baseline)', () => {
    const extracted = extractJson(PURE_FENCED_JSON);
    expect(() => JSON.parse(extracted)).not.toThrow();
    const parsed = JSON.parse(extracted);
    expect(parsed.executiveSummary).toBe('x');
  });

  it('parses markdown preamble + trailing fenced ```json block (bracket-bearing prose)', () => {
    // Prose contains `{`, `}`, `[1]`-style brackets — the kind that breaks
    // findFirstJsonStart/trimToBalancedJson on candidate 0.
    const extracted = extractJson(TRAILING_FENCE_ONLY);
    expect(() => JSON.parse(extracted)).not.toThrow();
    const parsed = JSON.parse(extracted);
    expect(parsed.executiveSummary).toBe('x');
  });

  it('parses full Gemini-style LITE deep research output (regression: "Report could not be fully parsed")', () => {
    const extracted = extractJson(LITE_STYLE_OUTPUT);
    expect(() => JSON.parse(extracted)).not.toThrow();
    const parsed = JSON.parse(extracted);
    // Shape assertions — all required DeepResearchReport fields must be present.
    expect(parsed.executiveSummary).toMatch(/Lumentum/);
    expect(parsed.bullCase).toMatch(/NVIDIA/);
    expect(parsed.baseCase).toBeTruthy();
    expect(parsed.bearCase).toBeTruthy();
    expect(Array.isArray(parsed.keyRisks)).toBe(true);
    expect(parsed.keyRisks.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.keyCatalysts)).toBe(true);
    expect(parsed.valuation).toBeTruthy();
    expect(parsed.valuation.method).toBeTruthy();
    expect(Array.isArray(parsed.valuation.comparables)).toBe(true);
    expect(parsed.valuation.comparables).toContain('COHR');
    expect(Array.isArray(parsed.citations)).toBe(true);
    expect(parsed.citations.length).toBeGreaterThanOrEqual(2);
    expect(parsed.citations[0]).toHaveProperty('title');
    expect(parsed.citations[0]).toHaveProperty('url');
    expect(parsed.confidenceNotes).toBeTruthy();
  });

  it('returns empty string for empty input (no throw)', () => {
    expect(extractJson('')).toBe('');
    expect(extractJson('   ')).toBe('');
  });
});
