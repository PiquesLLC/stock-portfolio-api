import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildSystemPrompt,
  applyLivePositionMoveData,
  detectDirectionMismatch,
  shouldAutoRegenerate,
  _resetAutoRegenCooldownForTests,
  type DailyReportResponse,
} from '../services/perplexity-daily-report.service';

const FORBIDDEN_INTRADAY_PHRASES = [
  /closed\s+(?:today|mixed|higher|lower|up|down|flat)/i,
  /ended\s+(?:today|the\s+(?:day|session))/i,
  /today'?s\s+close/i,
  /finished\s+the\s+(?:day|session)/i,
  /wrapped\s+up\s+the\s+session/i,
  /at\s+the\s+close/i,
];

describe('buildSystemPrompt — market-state branching', () => {
  it('intraday prompt forbids post-close phrasing', () => {
    const prompt = buildSystemPrompt('intraday');
    for (const re of FORBIDDEN_INTRADAY_PHRASES) {
      expect(
        prompt,
        `Intraday prompt must not contain post-close phrasing matching ${re}`,
      ).not.toMatch(re);
    }
  });

  it('intraday prompt does not contain past-tense triggers from the schema block', () => {
    const prompt = buildSystemPrompt('intraday');
    // These are LLM training-data triggers — past-tense morning-note phrasing pulls the
    // model toward "closed today" voice even when the voice block forbids it.
    const PAST_TENSE_TRIGGERS = [
      /moved this stock today/i,
      /Goldman\s+Sachs\s+morning\s+note/i,
      /drove\s+gains/i,
      /affected\s+their\s+stocks\s+TODAY/i,
      /If a holding moved\s*>?\s*2%/i,
    ];
    for (const re of PAST_TENSE_TRIGGERS) {
      expect(prompt, `Intraday prompt should not contain past-tense trigger ${re}`).not.toMatch(re);
    }
  });

  it('intraday prompt places the voice block AFTER the schema block (last instruction wins)', () => {
    const prompt = buildSystemPrompt('intraday');
    // Use a stable sentinel that only appears in the voice block.
    const schemaIdx = prompt.indexOf('Return ONLY valid JSON');
    const voiceIdx = prompt.indexOf('=== TENSE OVERRIDE');
    expect(schemaIdx).toBeGreaterThanOrEqual(0);
    expect(voiceIdx).toBeGreaterThanOrEqual(0);
    expect(voiceIdx).toBeGreaterThan(schemaIdx);
  });

  it('post_close prompt does not double-include the SHARED_OPENER persona line', () => {
    const prompt = buildSystemPrompt('post_close');
    const matches = prompt.match(/You are a Wall Street desk analyst writing a premium briefing for an institutional client/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it('weekend prompt does not double-include the SHARED_OPENER persona line', () => {
    const prompt = buildSystemPrompt('weekend');
    const matches = prompt.match(/You are a Wall Street desk analyst writing a premium briefing for an institutional client/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it('schema block does not contain present-perfect "have moved" past-tense hook', () => {
    expect(buildSystemPrompt('intraday')).not.toMatch(/have moved/i);
    expect(buildSystemPrompt('pre_open')).not.toMatch(/have moved/i);
  });

  it('intraday prompt explicitly instructs present tense / live language', () => {
    const prompt = buildSystemPrompt('intraday').toLowerCase();
    // At least one present-tense / live indicator should appear
    expect(
      /so far today|currently|session high|session low|intraday|markets are open|live/.test(prompt),
    ).toBe(true);
  });

  it('pre_open prompt mentions futures or pre-market', () => {
    const prompt = buildSystemPrompt('pre_open').toLowerCase();
    expect(/futures|pre[\s-]?market|overnight|gappers|opens?\s+at/.test(prompt)).toBe(true);
  });

  it('post_close prompt may use closing-recap phrasing', () => {
    const prompt = buildSystemPrompt('post_close');
    // Sanity: post_close is the only state allowed to say "closed today"
    expect(/closed today|today'?s close|at the close/i.test(prompt)).toBe(true);
  });

  it('schema block (shared across states) is tense-neutral', () => {
    // The schema block should not bias the LLM toward past tense — those phrasings live
    // only in VOICE_POST_CLOSE / VOICE_WEEKEND.
    const intradayPrompt = buildSystemPrompt('intraday');
    const preOpenPrompt = buildSystemPrompt('pre_open');
    for (const prompt of [intradayPrompt, preOpenPrompt]) {
      expect(prompt).not.toMatch(/moved this stock today/i);
      expect(prompt).not.toMatch(/affected\s+their\s+stocks\s+TODAY/i);
      expect(prompt).not.toMatch(/Goldman\s+Sachs\s+morning\s+note/i);
    }
  });

  it('weekend prompt references the week and Monday', () => {
    const prompt = buildSystemPrompt('weekend').toLowerCase();
    expect(/this week|last week|monday|recap/.test(prompt)).toBe(true);
  });
});

describe('applyLivePositionMoveData', () => {
  const baseReport: DailyReportResponse = {
    generatedAt: '2026-05-01T13:00:00Z',
    greeting: '',
    marketOverview: '',
    portfolioSummary: '',
    positionMoves: [
      { ticker: 'AMZN', changePercent: -0.9, reason: 'cached AWS slowdown narrative' },
      { ticker: 'ASML', changePercent: -0.8, reason: 'cached semi pressure narrative' },
      { ticker: 'VRT', changePercent: 0.4, reason: 'cached AI infra narrative' },
    ],
    topStories: [],
    watchToday: [],
    cached: true,
  };

  it('overrides changePercent from live portfolio data per ticker', () => {
    const live = {
      holdings: [
        { ticker: 'AMZN', dayChangePercent: 1.66, dayChange: 4.39 },
        { ticker: 'ASML', dayChangePercent: 0.5, dayChange: 3.2 },
        { ticker: 'VRT', dayChangePercent: -0.2, dayChange: -0.4 },
      ],
    };
    const updated = applyLivePositionMoveData(baseReport, live);
    expect(updated.positionMoves?.[0]).toMatchObject({ ticker: 'AMZN', changePercent: 1.66 });
    expect(updated.positionMoves?.[1]).toMatchObject({ ticker: 'ASML', changePercent: 0.5 });
    expect(updated.positionMoves?.[2]).toMatchObject({ ticker: 'VRT', changePercent: -0.2 });
  });

  it('preserves the LLM-written reason text after override', () => {
    const live = { holdings: [{ ticker: 'AMZN', dayChangePercent: 1.66, dayChange: 4.39 }] };
    const updated = applyLivePositionMoveData(baseReport, live);
    expect(updated.positionMoves?.[0].reason).toBe('cached AWS slowdown narrative');
  });

  it('drops position moves for tickers no longer in the live portfolio', () => {
    // Only AMZN is held; ASML and VRT have been sold (or were hallucinated by the LLM).
    const live = { holdings: [{ ticker: 'AMZN', dayChangePercent: 1.66, dayChange: 4.39 }] };
    const updated = applyLivePositionMoveData(baseReport, live);
    expect(updated.positionMoves).toHaveLength(1);
    expect(updated.positionMoves?.[0].ticker).toBe('AMZN');
    expect(updated.positionMoves?.[0].changePercent).toBe(1.66);
  });

  it('matches case-insensitively', () => {
    const live = { holdings: [{ ticker: 'amzn', dayChangePercent: 1.66, dayChange: 4.39 }] };
    const updated = applyLivePositionMoveData(baseReport, live);
    expect(updated.positionMoves?.[0].changePercent).toBe(1.66);
  });

  it('returns the report unchanged if positionMoves is missing', () => {
    const r: DailyReportResponse = { ...baseReport, positionMoves: undefined };
    const live = { holdings: [{ ticker: 'AMZN', dayChangePercent: 1.66, dayChange: 4.39 }] };
    const updated = applyLivePositionMoveData(r, live);
    expect(updated.positionMoves).toBeUndefined();
  });
});

describe('detectDirectionMismatch', () => {
  it('returns true when cached and live signs disagree above the noise threshold', () => {
    const cached: DailyReportResponse = {
      generatedAt: '', greeting: '', marketOverview: '', portfolioSummary: '',
      positionMoves: [{ ticker: 'AMZN', changePercent: -0.9, reason: '' }],
      topStories: [], watchToday: [], cached: true,
    };
    const live = { holdings: [{ ticker: 'AMZN', dayChangePercent: 1.66 }] };
    expect(detectDirectionMismatch(cached, live)).toBe(true);
  });

  it('returns false when either value is within ±0.25% of zero (noise floor)', () => {
    const cached: DailyReportResponse = {
      generatedAt: '', greeting: '', marketOverview: '', portfolioSummary: '',
      positionMoves: [{ ticker: 'AMZN', changePercent: -0.1, reason: '' }],
      topStories: [], watchToday: [], cached: true,
    };
    const live = { holdings: [{ ticker: 'AMZN', dayChangePercent: 0.2 }] };
    expect(detectDirectionMismatch(cached, live)).toBe(false);
  });

  it('returns true when cached is roughly flat but live is a real opposite-sign move', () => {
    const cached: DailyReportResponse = {
      generatedAt: '', greeting: '', marketOverview: '', portfolioSummary: '',
      positionMoves: [{ ticker: 'AMZN', changePercent: -0.1, reason: 'roughly flat narrative' }],
      topStories: [], watchToday: [], cached: true,
    };
    const live = { holdings: [{ ticker: 'AMZN', dayChangePercent: 1.5 }] };
    // Cached "flat" prose is wrong if the stock is actually +1.5% — regen.
    expect(detectDirectionMismatch(cached, live)).toBe(true);
  });

  it('returns false when live side is below noise floor regardless of cached value', () => {
    const cached: DailyReportResponse = {
      generatedAt: '', greeting: '', marketOverview: '', portfolioSummary: '',
      positionMoves: [{ ticker: 'AMZN', changePercent: -1.5, reason: '' }],
      topStories: [], watchToday: [], cached: true,
    };
    const live = { holdings: [{ ticker: 'AMZN', dayChangePercent: 0.05 }] };
    // Live is genuinely flat — don't burn a regen on noise.
    expect(detectDirectionMismatch(cached, live)).toBe(false);
  });

  it('returns false when both signs agree', () => {
    const cached: DailyReportResponse = {
      generatedAt: '', greeting: '', marketOverview: '', portfolioSummary: '',
      positionMoves: [
        { ticker: 'AMZN', changePercent: -0.9, reason: '' },
        { ticker: 'VRT',  changePercent: 0.4,  reason: '' },
      ],
      topStories: [], watchToday: [], cached: true,
    };
    const live = {
      holdings: [
        { ticker: 'AMZN', dayChangePercent: -1.2 },
        { ticker: 'VRT',  dayChangePercent: 0.6 },
      ],
    };
    expect(detectDirectionMismatch(cached, live)).toBe(false);
  });

  it('ignores tickers not present in live portfolio', () => {
    const cached: DailyReportResponse = {
      generatedAt: '', greeting: '', marketOverview: '', portfolioSummary: '',
      positionMoves: [{ ticker: 'AMZN', changePercent: -0.9, reason: '' }],
      topStories: [], watchToday: [], cached: true,
    };
    const live = { holdings: [{ ticker: 'TSLA', dayChangePercent: 1.0 }] };
    expect(detectDirectionMismatch(cached, live)).toBe(false);
  });

  it('returns false when positionMoves is undefined', () => {
    const cached: DailyReportResponse = {
      generatedAt: '', greeting: '', marketOverview: '', portfolioSummary: '',
      topStories: [], watchToday: [], cached: true,
    };
    const live = { holdings: [{ ticker: 'AMZN', dayChangePercent: 1.66 }] };
    expect(detectDirectionMismatch(cached, live)).toBe(false);
  });
});

describe('shouldAutoRegenerate cooldown', () => {
  beforeEach(() => {
    _resetAutoRegenCooldownForTests();
  });

  it('allows the first auto-regen for a user', () => {
    expect(shouldAutoRegenerate('user-1')).toBe(true);
  });

  it('blocks subsequent auto-regens within the cooldown window', () => {
    expect(shouldAutoRegenerate('user-1')).toBe(true);
    expect(shouldAutoRegenerate('user-1')).toBe(false);
    expect(shouldAutoRegenerate('user-1')).toBe(false);
  });

  it('treats different users independently', () => {
    expect(shouldAutoRegenerate('user-1')).toBe(true);
    expect(shouldAutoRegenerate('user-2')).toBe(true);
  });

  it('treats different portfolios for the same user independently', () => {
    expect(shouldAutoRegenerate('user-1', 'pf-a')).toBe(true);
    expect(shouldAutoRegenerate('user-1', 'pf-b')).toBe(true);
    expect(shouldAutoRegenerate('user-1', 'pf-a')).toBe(false);
  });
});
