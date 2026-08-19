import { describe, it, expect } from 'vitest';
import {
  isoWeekOf,
  pressureScore,
  blendEntryMomentum,
  sharedRankDeltas,
} from '../services/bottleneck-momentum.service';
import {
  buildMomentumResponse,
  getCatalogEntries,
  getSectorLayers,
  getEditorialAnchor,
} from '../services/ai-bottlenecks.service';
import type { BottleneckEntry, BottlenecksResponse, EntryMomentum } from '../services/ai-bottlenecks.service';
import type { HistoricalCandles } from '../utils/candle-cache';
import { validateAiOutput } from '../eval/financial-safety/validators/ai-output.validator';

// ── helpers ──────────────────────────────────────────────────────────

const SESSION = '2026-03-03'; // the session every synthetic series ends on

/**
 * Candles whose last close is `ret` above the close `days` sessions earlier.
 * `endSession` controls the final date, so date-alignment can be exercised.
 */
function candlesWithReturn(
  ticker: string,
  ret: number,
  days = 61,
  endSession = SESSION,
): HistoricalCandles {
  const closes: number[] = [];
  for (let i = 0; i <= days; i++) closes.push(100);
  closes[closes.length - 1] = 100 * (1 + ret);
  const end = new Date(`${endSession}T00:00:00Z`).getTime();
  return {
    ticker,
    closes,
    // Dates run backwards from endSession so the LAST entry is endSession.
    dates: closes.map((_, i) => new Date(end - (closes.length - 1 - i) * 86400000)),
    returns: [],
    fetchedAt: Date.now(),
    partial: false,
    daysAvailable: closes.length,
  };
}

function entry(over: Partial<BottleneckEntry> = {}): BottleneckEntry {
  return {
    id: 'e1',
    name: 'Entry',
    sector: 'AI',
    layer: 'Compute',
    primaryTicker: 'AAA',
    relatedTickers: [],
    thesisShort: '',
    thesisLong: '',
    chokepointMetrics: [],
    catalysts: [],
    risks: [],
    featured: false,
    lastUpdated: '2026-01-01',
    ...over,
  };
}

function momentum(over: Partial<EntryMomentum> = {}): EntryMomentum {
  return {
    score: 50,
    momentum: 0,
    rank: 1,
    rankDelta: null,
    isoWeek: '2026-W34',
    prevIsoWeek: null,
    tickersUsed: [],
    ...over,
  };
}

// ── ISO week keys ────────────────────────────────────────────────────

describe('isoWeekOf', () => {
  it('matches ISO-8601 week numbering', () => {
    // 2026-08-19 is a Wednesday in ISO week 34 (verified against `date -u +%V`).
    expect(isoWeekOf(new Date('2026-08-19T00:00:00Z'))).toBe('2026-W34');
    expect(isoWeekOf(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
  });

  it('keeps a Monday and the Sunday that ends its week in the SAME key', () => {
    // The whole point of a week key: every day Mon..Sun must map to one bucket,
    // or the job would rescore mid-week and reset the deltas users just saw.
    const monday = isoWeekOf(new Date('2026-08-17T00:00:00Z'));
    const sunday = isoWeekOf(new Date('2026-08-23T00:00:00Z'));
    expect(monday).toBe(sunday);
    expect(isoWeekOf(new Date('2026-08-24T00:00:00Z'))).not.toBe(monday);
  });

  it('assigns year-boundary days to the ISO year of their Thursday', () => {
    // 2025-12-29 (Mon) through 2026-01-04 (Sun) is ISO week 2026-W01, because
    // that week's Thursday falls in 2026. A naive getUTCFullYear() would file
    // the December days under 2025 and split one week across two keys.
    expect(isoWeekOf(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeekOf(new Date('2026-01-04T00:00:00Z'))).toBe('2026-W01');
  });
});

// ── score blending ───────────────────────────────────────────────────

describe('pressureScore', () => {
  it('weights the editorial anchor above momentum (60/40)', () => {
    // Top-layer entry with the worst possible momentum still outscores a
    // bottom-layer entry with the best — a quiet month must not bury a
    // structurally critical chokepoint.
    expect(pressureScore(1, -1)).toBeGreaterThan(pressureScore(0, 1));
  });

  it('is monotonic in momentum at a fixed anchor', () => {
    expect(pressureScore(0.5, 1)).toBeGreaterThan(pressureScore(0.5, 0));
    expect(pressureScore(0.5, 0)).toBeGreaterThan(pressureScore(0.5, -1));
  });

  it('spans 0..100 at the extremes', () => {
    expect(pressureScore(0, -1)).toBe(0);
    expect(pressureScore(1, 1)).toBe(100);
  });
});

describe('blendEntryMomentum', () => {
  const bench = 0; // SPY flat, so relative strength == raw return

  it('clamps at +/-1 beyond the saturation threshold', () => {
    const map = new Map([['AAA', candlesWithReturn('AAA', 2.0)]]);
    const out = blendEntryMomentum(entry(), map, bench, bench);
    expect(out?.momentum).toBe(1);

    const down = new Map([['AAA', candlesWithReturn('AAA', -0.9)]]);
    expect(blendEntryMomentum(entry(), down, bench, bench)?.momentum).toBe(-1);
  });

  it('weights the primary ticker above related names', () => {
    // Primary flat, related strongly up. Primary carries 60%, so the blend must
    // stay closer to zero than to the related ticker's reading.
    const map = new Map([
      ['AAA', candlesWithReturn('AAA', 0)],
      ['BBB', candlesWithReturn('BBB', 0.25)],
    ]);
    const out = blendEntryMomentum(entry({ relatedTickers: ['BBB'] }), map, bench, bench);
    expect(out?.momentum).toBeCloseTo(0.4, 5); // 0.6*0 + 0.4*1
  });

  it('renormalizes over resolved tickers so a missing name does not drag toward zero', () => {
    // BBB has no candles. The entry should read as its primary alone, not as
    // primary diluted by an implicit zero.
    const map = new Map([['AAA', candlesWithReturn('AAA', 0.25)]]);
    const out = blendEntryMomentum(entry({ relatedTickers: ['BBB'] }), map, bench, bench);
    expect(out?.momentum).toBe(1);
    expect(out?.used).toEqual(['AAA']);
    expect(out?.missed).toEqual(['BBB']);
  });

  it('returns null when no ticker has usable history', () => {
    expect(blendEntryMomentum(entry(), new Map(), bench, bench)).toBeNull();
  });

  it('measures strength relative to the benchmark, not raw return', () => {
    // Up 10% while SPY is up 10% is NOT momentum. (toBeCloseTo, not toBe: the
    // subtraction leaves float dust on the order of 1e-16.)
    const map = new Map([['AAA', candlesWithReturn('AAA', 0.1)]]);
    expect(blendEntryMomentum(entry(), map, 0.1, 0.1)?.momentum).toBeCloseTo(0, 10);
  });

  it('scores off related tickers alone when there is no primary', () => {
    const map = new Map([['BBB', candlesWithReturn('BBB', 0.25)]]);
    const out = blendEntryMomentum(entry({ primaryTicker: '', relatedTickers: ['BBB'] }), map, bench, bench);
    expect(out?.momentum).toBe(1);
    expect(out?.used).toEqual(['BBB']);
  });

  it('uses the short window alone when history covers 20 days but not 60', () => {
    // 21 closes: enough for the 20-day window, not the 60-day one. The ticker
    // must still score off the short window rather than being discarded.
    const map = new Map([['AAA', candlesWithReturn('AAA', 0.25, 20)]]);
    const out = blendEntryMomentum(entry(), map, 0, 0);
    expect(out?.used).toEqual(['AAA']);
    expect(out?.momentum).toBe(1); // 25% relative == full scale, short-only
  });

  it('rejects a series with too little history for even the short window', () => {
    // 20 closes — totalReturn needs days+1 = 21. Boundary, off by exactly one.
    const map = new Map([['AAA', candlesWithReturn('AAA', 0.25, 19)]]);
    expect(blendEntryMomentum(entry(), map, 0, 0)).toBeNull();
  });

  describe('date alignment with the benchmark', () => {
    // Index-aligned is not date-aligned. Ticker candles can be restored from a
    // disk snapshot up to ~48h stale while SPY is fetched fresh, so comparing
    // "last 20 bars" of each would measure two different date spans and fold
    // the benchmark's intervening move into the ticker's relative return.
    it('skips a ticker whose series ends on a different session than the benchmark', () => {
      const map = new Map([['AAA', candlesWithReturn('AAA', 0.25, 61, '2026-02-27')]]);
      const out = blendEntryMomentum(entry(), map, 0, 0, SESSION);
      expect(out).toBeNull();
    });

    it('accepts a ticker whose series ends on the benchmark session', () => {
      const map = new Map([['AAA', candlesWithReturn('AAA', 0.25, 61, SESSION)]]);
      expect(blendEntryMomentum(entry(), map, 0, 0, SESSION)?.used).toEqual(['AAA']);
    });

    it('drops only the misaligned ticker, keeping the aligned one', () => {
      const map = new Map([
        ['AAA', candlesWithReturn('AAA', 0, 61, '2026-02-27')], // stale, skipped
        ['BBB', candlesWithReturn('BBB', 0.25, 61, SESSION)],
      ]);
      const out = blendEntryMomentum(entry({ relatedTickers: ['BBB'] }), map, 0, 0, SESSION);
      expect(out?.used).toEqual(['BBB']);
      expect(out?.missed).toEqual(['AAA']);
      expect(out?.momentum).toBe(1); // renormalized onto BBB alone
    });

    it('disables the check when no benchmark session is supplied', () => {
      const map = new Map([['AAA', candlesWithReturn('AAA', 0.25, 61, '2020-01-01')]]);
      expect(blendEntryMomentum(entry(), map, 0, 0, '')?.used).toEqual(['AAA']);
    });
  });
});

// ── rank deltas vs catalog churn ─────────────────────────────────────

describe('sharedRankDeltas', () => {
  // The catalog is regenerated weekly by an external routine that adds and
  // removes entries. Diffing raw ranks would report every surviving entry as
  // having moved whenever entries are inserted above them.
  it('reports no movement when order is unchanged', () => {
    const deltas = sharedRankDeltas(['a', 'b', 'c'], new Map([['a', 1], ['b', 2], ['c', 3]]));
    expect([...deltas.values()]).toEqual([0, 0, 0]);
  });

  it('reports real movement when order actually changes', () => {
    // c climbed from 3rd to 1st; a fell from 1st to 3rd.
    const deltas = sharedRankDeltas(['c', 'b', 'a'], new Map([['a', 1], ['b', 2], ['c', 3]]));
    expect(deltas.get('c')).toBe(2);
    expect(deltas.get('b')).toBe(0);
    expect(deltas.get('a')).toBe(-2);
  });

  it('reports NO movement when two new entries are inserted at the top', () => {
    // THE REGRESSION THIS FUNCTION EXISTS FOR. Raw sector ranks would show
    // a, b, c each down 2 and fill the movers strip with entries that did not
    // move at all — the delta would be measuring catalog churn, not price.
    const deltas = sharedRankDeltas(['new1', 'new2', 'a', 'b', 'c'], new Map([['a', 1], ['b', 2], ['c', 3]]));
    expect(deltas.get('a')).toBe(0);
    expect(deltas.get('b')).toBe(0);
    expect(deltas.get('c')).toBe(0);
  });

  it('reports no movement for survivors when an entry is removed', () => {
    // 'b' left the catalog; a and c kept their relative order.
    const deltas = sharedRankDeltas(['a', 'c'], new Map([['a', 1], ['b', 2], ['c', 3]]));
    expect(deltas.get('a')).toBe(0);
    expect(deltas.get('c')).toBe(0);
  });

  it('omits entries with no prior rank so they surface as null, not as movement', () => {
    const deltas = sharedRankDeltas(['new1', 'a'], new Map([['a', 1]]));
    expect(deltas.has('new1')).toBe(false);
    expect(deltas.get('a')).toBe(0);
  });

  it('returns an empty map when there is no prior week at all', () => {
    expect(sharedRankDeltas(['a', 'b'], new Map()).size).toBe(0);
  });
});

// ── ordering contract ────────────────────────────────────────────────

describe('buildMomentumResponse', () => {
  const base = (): BottlenecksResponse => ({
    sectors: ['AI'],
    layers: ['Compute', 'Memory'],
    featured: { AI: null },
    entries: [
      entry({ id: 'c1', name: 'Compute One', layer: 'Compute' }),
      entry({ id: 'c2', name: 'Compute Two', layer: 'Compute' }),
      entry({ id: 'm1', name: 'Memory One', layer: 'Memory' }),
    ],
    generatedAt: '2026-08-17T00:00:00Z',
    movers: {},
    momentumWeek: null,
  });

  it('returns the catalog untouched when no scores exist', () => {
    // The endpoint must survive the job never having run.
    const out = buildMomentumResponse(base(), new Map());
    expect(out.entries.map(e => e.id)).toEqual(['c1', 'c2', 'm1']);
    expect(out.momentumWeek).toBeNull();
  });

  it('reorders WITHIN a layer but never across layers', () => {
    // c2 outscores every Compute entry AND the Memory entry, but Memory ranks
    // below Compute editorially — so m1 must still come last.
    const scores = new Map([
      ['c1', momentum({ score: 10 })],
      ['c2', momentum({ score: 90 })],
      ['m1', momentum({ score: 99 })],
    ]);
    const out = buildMomentumResponse(base(), scores);
    expect(out.entries.map(e => e.id)).toEqual(['c2', 'c1', 'm1']);
  });

  it('sinks unscored entries to the bottom of their own layer', () => {
    const scores = new Map([['c2', momentum({ score: 50 })]]);
    const out = buildMomentumResponse(base(), scores);
    expect(out.entries.map(e => e.id)).toEqual(['c2', 'c1', 'm1']);
  });

  it('ranks movers by absolute movement and excludes non-movers', () => {
    const scores = new Map([
      ['c1', momentum({ score: 10, rank: 3, rankDelta: -1 })],
      ['c2', momentum({ score: 90, rank: 1, rankDelta: 5 })],
      ['m1', momentum({ score: 50, rank: 2, rankDelta: 0 })],
    ]);
    const out = buildMomentumResponse(base(), scores);
    expect(out.movers.AI.map(m => m.id)).toEqual(['c2', 'c1']);
    expect(out.movers.AI[0].rankDelta).toBe(5);
  });

  it('excludes entries whose delta is null (first scored week)', () => {
    const scores = new Map([['c1', momentum({ rankDelta: null })]]);
    expect(buildMomentumResponse(base(), scores).movers.AI).toEqual([]);
  });

  it('reports the ISO week the scores belong to', () => {
    const scores = new Map([['c1', momentum({ isoWeek: '2026-W34' })]]);
    expect(buildMomentumResponse(base(), scores).momentumWeek).toBe('2026-W34');
  });
});

// ── real-catalog guards ──────────────────────────────────────────────

describe('editorial anchor against the SHIPPED catalogs', () => {
  // These run against the real JSON, not fixtures, because the catalogs are
  // edited every week by an autonomous cloud routine that can add layers,
  // reorder LAYER_ORDER, and swap tickers. If it introduces a layer that
  // LAYER_ORDER doesn't know about, getEditorialAnchor silently returns 0 for
  // it and every entry in that layer sinks to the bottom of its sector with no
  // error anywhere. These tests are the tripwire for that.
  const SECTORS = ['AI', 'Healthcare', 'Defense', 'Energy'];

  it('ships a non-empty catalog', () => {
    expect(getCatalogEntries().length).toBeGreaterThan(0);
  });

  it('gives every sector layer an anchor inside 0..1, spanning the full range', () => {
    for (const sector of SECTORS) {
      const layers = getSectorLayers(sector);
      expect(layers.length, `${sector} has no layers`).toBeGreaterThan(0);

      const anchors = layers.map(l => getEditorialAnchor(sector, l));
      for (const [i, a] of anchors.entries()) {
        expect(a, `${sector}/${layers[i]} anchor out of range`).toBeGreaterThanOrEqual(0);
        expect(a, `${sector}/${layers[i]} anchor out of range`).toBeLessThanOrEqual(1);
      }
      // Top layer anchors at 1, bottom at 0 — otherwise the 60/40 blend is
      // not spanning the range it was tuned against.
      expect(Math.max(...anchors), `${sector} top anchor`).toBe(1);
      expect(Math.min(...anchors), `${sector} bottom anchor`).toBe(0);
    }
  });

  it('anchors strictly decrease down the editorial layer order', () => {
    for (const sector of SECTORS) {
      const anchors = getSectorLayers(sector).map(l => getEditorialAnchor(sector, l));
      for (let i = 1; i < anchors.length; i++) {
        expect(anchors[i], `${sector} anchor did not decrease at index ${i}`).toBeLessThan(anchors[i - 1]);
      }
    }
  });

  it('every entry carries a primary ticker to score', () => {
    // An entry with no primaryTicker can still be scored off its related
    // tickers, but with none at all it silently drops out of the ranking.
    const unscorable = getCatalogEntries().filter(
      e => !e.primaryTicker && (!e.relatedTickers || e.relatedTickers.length === 0),
    );
    expect(unscorable.map(e => e.id)).toEqual([]);
  });
});

// ── framing guard ────────────────────────────────────────────────────

describe('momentum copy stays activity-framed, not merit-framed', () => {
  // A momentum ranking is the easiest place in the product for advice language
  // to creep back in — "top picks this week" is one careless edit away, and it
  // would put a recommendation in front of users under the guise of a sort
  // order. These strings mirror the user-facing copy in the UI repo
  // (BottleneckMovers.tsx, BottleneckDrawer.tsx, BottleneckRankDelta.tsx);
  // update both together.
  const SHIPPED_COPY = [
    'Moving this week',
    'This week',
    'Change in rank within AI since the previous scored week. Reflects recent price movement and our assessment of the chokepoint — not a recommendation.',
    'Placement reflects recent price movement across this chokepoint’s tickers and our assessment of how binding the chokepoint is. It is not a recommendation.',
    'Up 6 from last week. Over the last 4–12 weeks NVDA, AVGO traded well ahead of the S&P 500.',
    'Up 6 since week 31. Over the last 4–12 weeks NVDA traded ahead of the S&P 500.',
    'Down 2 from last week. Over the last 4–12 weeks ASML traded behind the S&P 500.',
    'Unchanged from last week.',
    'First week in the ranking.',
    'Moved up 6 places in AI in the latest weekly ranking',
  ];

  /**
   * Merit vocabulary — the words that turn a sort order into a recommendation.
   *
   * This list is asserted DIRECTLY rather than delegated to validateAiOutput,
   * because that validator has no merit-framing rule: its categories are
   * guarantee / price_target / trade_imperative / leverage / concentration /
   * fomo / unhedged_prediction / personalized_advice. "This week's strongest
   * chokepoints" passes it cleanly. Asserting only against the validator would
   * be asserting that advice-free copy contains no advice verbs — true, and
   * completely blind to the regression this guard is supposed to catch.
   */
  const MERIT_VOCABULARY =
    /\b(strongest|best|top pick|top picks|leaders?|winners?|outperform\w*|undervalued|overvalued|buy|sell|hold|bullish|bearish)\b/i;

  it('contains no merit or advice vocabulary', () => {
    for (const copy of SHIPPED_COPY) {
      expect(MERIT_VOCABULARY.test(copy), `merit framing in: ${copy}`).toBe(false);
    }
  });

  it('would catch the framing this feature deliberately rejected', () => {
    // Proves the matcher above is live. If these stop matching, the guard has
    // been weakened and the assertion on shipped copy means nothing.
    for (const banned of [
      "This week's strongest chokepoints",
      'AI leaders',
      'Top picks in Defense',
      'The best names in Energy right now',
    ]) {
      expect(MERIT_VOCABULARY.test(banned), `should have been caught: ${banned}`).toBe(true);
    }
  });

  it('also passes the financial-safety validator', () => {
    // Secondary check. Covers the advice categories the regex above doesn't —
    // price targets, guarantees, personalised advice — not merit framing.
    for (const copy of SHIPPED_COPY) {
      const verdict = validateAiOutput(copy, { minSeverity: 'high' });
      expect(verdict.violations, `flagged: ${copy}`).toEqual([]);
    }
  });

  it('the financial-safety validator still rejects outright advice', () => {
    const banned = 'You should buy NVDA now, it is guaranteed to hit $250.';
    expect(validateAiOutput(banned).ok).toBe(false);
  });
});
