import { describe, it, expect } from 'vitest';
import { buildDeepResearchPrompt } from '../services/deep-research.service';

// Regression: Apr 16 2026 — user requested deep research on LITE (Lumentum)
// and received a report about GOOGL instead. Root cause: the ticker was stored
// in the DB row but never injected into the LLM prompt, so Gemini saw only
// {SYSTEM_PROMPT + portfolio + free-text user prompt}. Since the user's
// portfolio has a heavy GOOGL allocation, Gemini latched onto the most
// prominent holding and wrote a report about it.
//
// These tests pin the contract that `buildDeepResearchPrompt` MUST inject the
// ticker (and research type) into the prompt so the model cannot silently
// substitute a different company.

const PORTFOLIO_CONTEXT = `Portfolio: 18 holdings, $494,000 total value.
Top positions: GOOGL (13%, $67,296, +74.9% unrealized), AAPL (8%), NVDA (7%),
MSFT (6%), TSLA (5%).`;

describe('buildDeepResearchPrompt — ticker-focus contract', () => {
  it('injects the ticker into the prompt when opts.ticker is provided', () => {
    const prompt = buildDeepResearchPrompt(
      PORTFOLIO_CONTEXT,
      'Give me a deep research report.',
      { ticker: 'LITE', researchType: 'stock' },
    );
    // The ticker must appear somewhere the model reads before the portfolio.
    expect(prompt).toContain('LITE');
  });

  it('places the research-focus block BEFORE the portfolio context', () => {
    // Otherwise the model reads the portfolio first and anchors on the biggest
    // holding (GOOGL) before it sees the instruction about LITE.
    const prompt = buildDeepResearchPrompt(
      PORTFOLIO_CONTEXT,
      'Deep research please.',
      { ticker: 'LITE', researchType: 'stock' },
    );
    const tickerIdx = prompt.indexOf('LITE');
    const portfolioIdx = prompt.indexOf('PORTFOLIO CONTEXT');
    expect(tickerIdx).toBeGreaterThan(-1);
    expect(portfolioIdx).toBeGreaterThan(-1);
    expect(tickerIdx).toBeLessThan(portfolioIdx);
  });

  it('explicitly forbids substituting a different ticker from the portfolio', () => {
    // This is the core regression. The instruction must be emphatic enough
    // that the model will not "helpfully" swap in a more familiar mega-cap.
    const prompt = buildDeepResearchPrompt(
      PORTFOLIO_CONTEXT,
      'Research this.',
      { ticker: 'LITE', researchType: 'stock' },
    );
    // Anti-substitution language — not asserting exact wording, just that the
    // intent is present.
    expect(prompt).toMatch(/MUST be about LITE/i);
    expect(prompt).toMatch(/do NOT substitute|must not substitute|only this ticker/i);
  });

  it('includes the research type label when provided', () => {
    const prompt = buildDeepResearchPrompt(
      PORTFOLIO_CONTEXT,
      'Deep research please.',
      { ticker: 'LITE', researchType: 'sector' },
    );
    expect(prompt).toMatch(/sector/i);
  });

  it('omits the ticker line when opts.ticker is undefined', () => {
    const prompt = buildDeepResearchPrompt(
      PORTFOLIO_CONTEXT,
      'Portfolio review please.',
      { researchType: 'portfolio' },
    );
    // No focus-ticker line — portfolio-level research has no single ticker.
    expect(prompt).not.toMatch(/Primary ticker:/);
  });

  it('preserves the existing sections (system prompt, portfolio, user request)', () => {
    const prompt = buildDeepResearchPrompt(
      PORTFOLIO_CONTEXT,
      'Analyze LITE please.',
      { ticker: 'LITE', researchType: 'stock' },
    );
    expect(prompt).toContain('USER PORTFOLIO CONTEXT');
    expect(prompt).toContain('USER RESEARCH REQUEST');
    expect(prompt).toContain(PORTFOLIO_CONTEXT);
    expect(prompt).toContain('Analyze LITE please.');
  });
});
