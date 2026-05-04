import { describe, it, expect } from 'vitest';
import { rewriteToPresentTense, applyTenseRewriteIfLive } from '../services/tense-rewrite';
import type { DailyReportResponse } from '../services/perplexity-daily-report.service';

// These are real past-tense lines extracted from a sonar-pro response on a Friday at 3:30 PM ET.
// The fixer is graded on whether it eliminates the past-simple session verbs while preserving
// numbers, tickers, percentages, and rough sentence shape.

describe('rewriteToPresentTense — surface-level verb rewrites', () => {
  it('rewrites "advanced" to a present-tense form', () => {
    const out = rewriteToPresentTense('the S&P 500 advanced +0.5%');
    expect(out).not.toMatch(/\badvanced\b/);
    expect(out.toLowerCase()).toMatch(/is up|is advancing/);
    expect(out).toContain('+0.5%');
  });

  it('rewrites "surged" to a present-tense form', () => {
    const out = rewriteToPresentTense('the Nasdaq surged approximately +1.2%');
    expect(out).not.toMatch(/\bsurged\b/);
    expect(out).toContain('+1.2%');
  });

  it('rewrites "rose" / "fell" / "dropped"', () => {
    expect(rewriteToPresentTense('AMZN rose 1.7% today')).not.toMatch(/\brose\b/);
    expect(rewriteToPresentTense('AXP fell 1.0% today')).not.toMatch(/\bfell\b/);
    expect(rewriteToPresentTense('the VIX dropped to 16.0')).not.toMatch(/\bdropped\b/);
  });

  it('rewrites "gained" / "lost" / "posted"', () => {
    expect(rewriteToPresentTense('SPY gained 0.5% today')).not.toMatch(/\bgained\b/);
    expect(rewriteToPresentTense('your portfolio lost 0.3%')).not.toMatch(/\blost\b/);
    expect(rewriteToPresentTense('your portfolio posted a +0.8% gain')).not.toMatch(/\bposted\b/);
  });

  it('rewrites "held firm"', () => {
    const out = rewriteToPresentTense('The 10-year Treasury yield held firm at 4.25%');
    expect(out.toLowerCase()).not.toMatch(/\bheld firm\b/);
    expect(out).toContain('4.25%');
  });

  it('rewrites session bookend phrases "closed out" and "kicked off"', () => {
    expect(rewriteToPresentTense('Equity markets closed out a strong April')).not.toMatch(/\bclosed out\b/);
    expect(rewriteToPresentTense('Equity markets kicked off May with risk-on')).not.toMatch(/\bkicked off\b/);
  });

  it('rewrites "delivered"', () => {
    const out = rewriteToPresentTense('Your portfolio delivered a strong performance today');
    expect(out).not.toMatch(/\bdelivered\b/);
  });

  it('rewrites "lagged"', () => {
    const out = rewriteToPresentTense('AXP lagged the market, declining 1.0%');
    expect(out).not.toMatch(/\blagged\b/);
  });

  it('rewrites "saw" in "WMT saw a 0.2% dip"', () => {
    const out = rewriteToPresentTense('Walmart (WMT) saw a minor -0.2% dip');
    expect(out).not.toMatch(/\bsaw\b/);
    expect(out).toContain('WMT');
  });

  it('does not modify already-present-tense prose', () => {
    const text = 'AMZN is climbing 1.7% in the session and is outperforming SPY';
    expect(rewriteToPresentTense(text)).toBe(text);
  });

  it('is idempotent — running twice gives the same result', () => {
    const text = 'the S&P 500 advanced +0.5% and the Nasdaq surged +1.2%';
    const once = rewriteToPresentTense(text);
    expect(rewriteToPresentTense(once)).toBe(once);
  });

  it('preserves tickers, numbers, percentages, and dollar figures', () => {
    const text = 'AMZN gained 1.66% ($4.39) and AXP fell 1.0% today';
    const out = rewriteToPresentTense(text);
    expect(out).toContain('AMZN');
    expect(out).toContain('AXP');
    expect(out).toContain('1.66%');
    expect(out).toContain('$4.39');
    expect(out).toContain('1.0%');
  });

  it('handles plural subjects with "are" not "is"', () => {
    const out = rewriteToPresentTense('Equity markets advanced 0.5% today');
    // Should contain "markets are" or "markets ... are" not "markets is"
    expect(out).not.toMatch(/markets\s+is\b/i);
  });

  it('does not break unrelated past-tense verbs (e.g. "reported")', () => {
    // "reported" in earnings context is a fact about a company event; leave it alone.
    const text = 'AMZN reported earnings last week';
    expect(rewriteToPresentTense(text)).toContain('reported');
  });

  it('skips rewrite when the captured "subject" is a conjunction', () => {
    // "and kicked off" should NOT become "and is kicking off" — "and" is a conjunction,
    // the actual subject is in the prior clause.
    const out = rewriteToPresentTense('Equity markets advanced +0.5% and kicked off May strong');
    expect(out).not.toMatch(/\band\s+is\s+kicking\b/i);
    expect(out).not.toMatch(/\band\s+are\s+kicking\b/i);
    // The first verb still gets rewritten (Equity markets are advancing)
    expect(out).toMatch(/markets\s+are\s+advancing/i);
  });

  it('skips rewrite when the captured "subject" is "while" or "as"', () => {
    expect(rewriteToPresentTense('AMZN advanced 1% as fell into red')).not.toMatch(/as\s+(is|are)\s+falling/i);
    expect(rewriteToPresentTense('AMZN gained while WMT lagged')).toMatch(/WMT\s+is\s+lagging/i);
  });

  it('"Shares of TICKER rose" uses plural "are" because the head noun is Shares', () => {
    const out = rewriteToPresentTense('Shares of AMZN rose 1.7% today');
    expect(out).toMatch(/Shares\s+of\s+AMZN\s+are\s+rising/i);
    expect(out).not.toMatch(/AMZN\s+is\s+rising/i);
  });

  it('"Shares of TICKER" works for fell, advanced, climbed, etc.', () => {
    expect(rewriteToPresentTense('Shares of GOOGL fell -0.5%')).toMatch(/Shares\s+of\s+GOOGL\s+are\s+falling/i);
    expect(rewriteToPresentTense('Shares of NVDA advanced +2%')).toMatch(/Shares\s+of\s+NVDA\s+are\s+advancing/i);
  });

  it('skips compound-subject markers "both" / "each" / "all"', () => {
    // The actual subject is in the prior clause; rewriting "both is climbing" would be wrong.
    expect(rewriteToPresentTense('AMZN and GOOGL both climbed today')).not.toMatch(/both\s+(is|are)\s+climbing/i);
    expect(rewriteToPresentTense('all gained today')).not.toMatch(/all\s+(is|are)\s+gaining/i);
  });

  it('"ended the year/quarter/month/week" stays past tense (period completion is real history)', () => {
    expect(rewriteToPresentTense('Markets ended the year at record highs')).toContain('ended the year');
    expect(rewriteToPresentTense('Markets finished the quarter strong')).toContain('finished the quarter');
    expect(rewriteToPresentTense('SPY ended the month +3%')).toContain('ended the month');
  });

  it('"ended" without a long-period object still gets rewritten', () => {
    // "ended higher" / "ended in the green" should still be intraday-rewritten.
    expect(rewriteToPresentTense('SPY ended higher today')).toMatch(/SPY\s+is\s+ending/i);
  });

  it('"they" subject takes "are" not "is"', () => {
    const out = rewriteToPresentTense('They advanced today');
    expect(out).toMatch(/They\s+are\s+advancing/i);
  });

  it('does not break appositive lead-ins ending in comma or colon', () => {
    // "In April, advanced 0.5%" — the captured subject is "April," (with comma). We don't
    // want "April, is advancing 0.5%" — leave the clause untouched.
    const out1 = rewriteToPresentTense('In April, advanced 0.5%');
    expect(out1).not.toMatch(/April,\s+(is|are)\s+advancing/i);
    const out2 = rewriteToPresentTense('By Friday: rose 1.2%');
    expect(out2).not.toMatch(/Friday:\s+(is|are)\s+rising/i);
  });

  it('does not break em-dash / en-dash / hyphen lead-ins', () => {
    expect(rewriteToPresentTense('Markets — and bonds — advanced 0.5%')).not.toMatch(/—\s+(is|are)\s+advancing/);
    expect(rewriteToPresentTense('Markets – advanced 0.5%')).not.toMatch(/–\s+(is|are)\s+advancing/);
    expect(rewriteToPresentTense('Stocks - rose 1%')).not.toMatch(/-\s+(is|are)\s+rising/);
  });

  it('handles lowercase "shares of TICKER" mid-sentence (not just sentence-initial)', () => {
    // "Some shares of AMZN rose 1%" — Pass 1 should still match because the regex uses
    // the case-insensitive flag.
    const out = rewriteToPresentTense('Some shares of AMZN rose 1% in trading');
    expect(out).toMatch(/shares\s+of\s+AMZN\s+are\s+rising/i);
    expect(out).not.toMatch(/AMZN\s+is\s+rising/i);
  });

  it('lowercase "Shares" preserves original case in output', () => {
    expect(rewriteToPresentTense('Shares of AMZN rose 1%')).toContain('Shares of AMZN are rising');
    expect(rewriteToPresentTense('shares of AMZN rose 1%')).toContain('shares of AMZN are rising');
    expect(rewriteToPresentTense('SHARES of AMZN rose 1%')).toContain('SHARES of AMZN are rising');
  });

  // Regression: May 4, 2026 — user reported intraday brief at 11am ET reading
  // "Your portfolio navigated a mixed market today, posting a +0.2% gain". The post-processor
  // was wired up correctly but `navigated` (and a few other common Perplexity verbs) were
  // missing from VERB_MAP, so they passed through untouched.
  it('rewrites "navigated" to "is navigating" (regression: portfolio-narrative verb)', () => {
    const out = rewriteToPresentTense('Your portfolio navigated a mixed market today');
    expect(out).not.toMatch(/\bnavigated\b/);
    expect(out).toMatch(/portfolio\s+is\s+navigating/i);
  });

  it('rewrites "outperformed" / "underperformed"', () => {
    expect(rewriteToPresentTense('AMZN outperformed the index by 1.2%'))
      .toMatch(/AMZN\s+is\s+outperforming/i);
    expect(rewriteToPresentTense('WMT underperformed the sector today'))
      .toMatch(/WMT\s+is\s+underperforming/i);
  });

  it('rewrites "dipped" / "ticked" / "pushed"', () => {
    expect(rewriteToPresentTense('the S&P dipped 0.1%')).toMatch(/S&P\s+is\s+dipping/i);
    expect(rewriteToPresentTense('the VIX ticked up to 18.5')).toMatch(/VIX\s+is\s+ticking/i);
    expect(rewriteToPresentTense('NVDA pushed past $900')).toMatch(/NVDA\s+is\s+pushing/i);
  });

  it('"navigated" / "outperformed" / "underperformed" stay past tense for completed periods', () => {
    // Period-noop guard preserves real completed-period statements. The lookahead allows
    // determiners "the | last | this | next | each" before year/quarter/month/week.
    // Note: only `the | last | this | each` produce semantically valid sentences for a
    // completed period — "next quarter" is future-tense nonsense the LLM should never emit.
    // The `next` branch is in the lookahead defensively (so we don't compound bad LLM output
    // by tense-rewriting it), but is intentionally not asserted here.
    expect(rewriteToPresentTense('the fund navigated the quarter well')).toContain('navigated the quarter');
    expect(rewriteToPresentTense('AMZN outperformed last quarter')).toContain('outperformed last quarter');
    expect(rewriteToPresentTense('WMT underperformed this year')).toContain('underperformed this year');
    expect(rewriteToPresentTense('the fund navigated each quarter with discipline')).toContain('navigated each quarter');
  });

  it('idempotent on the newly-added verbs', () => {
    const text = 'Your portfolio navigated a mixed market today, AMZN outperformed SPY, and the VIX ticked up to 18.5';
    const once = rewriteToPresentTense(text);
    expect(rewriteToPresentTense(once)).toBe(once);
  });
});

describe('applyTenseRewriteIfLive — gating on market state', () => {
  const baseReport: DailyReportResponse = {
    generatedAt: '2026-05-01T19:30:00Z',
    greeting: 'Risk-on sentiment propelled markets higher',
    marketOverview: 'the S&P 500 advanced +0.5% and the Nasdaq surged +1.2%',
    portfolioSummary: 'Your portfolio delivered a strong performance today',
    positionMoves: [
      { ticker: 'AMZN', changePercent: 1.66, reason: 'AMZN rose 1.66% on AI optimism' },
      { ticker: 'AXP',  changePercent: -1.0, reason: 'AXP lagged the market today' },
    ],
    topStories: [
      { headline: 'SPY gained 0.5%', body: 'SPY closed out the week with strong gains', sentiment: 'positive', relatedTickers: ['SPY'] },
    ],
    watchToday: [],
    cached: true,
  };

  it('rewrites all narrative fields when state is intraday', () => {
    const out = applyTenseRewriteIfLive(baseReport, 'intraday');
    expect(out.marketOverview).not.toMatch(/\badvanced\b/);
    expect(out.marketOverview).not.toMatch(/\bsurged\b/);
    expect(out.portfolioSummary).not.toMatch(/\bdelivered\b/);
    expect(out.positionMoves?.[0].reason).not.toMatch(/\brose\b/);
    expect(out.positionMoves?.[1].reason).not.toMatch(/\blagged\b/);
    expect(out.topStories[0].body).not.toMatch(/\bclosed out\b/);
    expect(out.topStories[0].headline).not.toMatch(/\bgained\b/);
  });

  it('rewrites narrative fields when state is pre_open', () => {
    const out = applyTenseRewriteIfLive(baseReport, 'pre_open');
    expect(out.marketOverview).not.toMatch(/\badvanced\b/);
  });

  it('is a no-op when state is post_close', () => {
    const out = applyTenseRewriteIfLive(baseReport, 'post_close');
    expect(out.marketOverview).toBe(baseReport.marketOverview);
    expect(out.portfolioSummary).toBe(baseReport.portfolioSummary);
    expect(out.positionMoves).toEqual(baseReport.positionMoves);
  });

  it('is a no-op when state is weekend', () => {
    const out = applyTenseRewriteIfLive(baseReport, 'weekend');
    expect(out.marketOverview).toBe(baseReport.marketOverview);
  });

  it('preserves all non-narrative fields untouched', () => {
    const out = applyTenseRewriteIfLive(baseReport, 'intraday');
    expect(out.generatedAt).toBe(baseReport.generatedAt);
    expect(out.cached).toBe(baseReport.cached);
    expect(out.positionMoves?.[0].ticker).toBe('AMZN');
    expect(out.positionMoves?.[0].changePercent).toBe(1.66);
  });
});
