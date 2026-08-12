import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const {
  getQuoteMock,
  getQuotesMock,
  searchSymbolsMock,
  getStockProfileMock,
  getStockMetricsMock,
  getPolygonQuotesMock,
  getPolygonQuoteMock,
  yahooGetMock,
  fetchPolygonAggsMock,
  getMarketSessionMock,
  getMarketSessionForTickerMock,
  tradesOnWeekendsMock,
  tradesWithinEtCalendarDayMock,
} = vi.hoisted(() => ({
  getQuoteMock: vi.fn(),
  getQuotesMock: vi.fn(),
  searchSymbolsMock: vi.fn(),
  getStockProfileMock: vi.fn(),
  getStockMetricsMock: vi.fn(),
  getPolygonQuotesMock: vi.fn(),
  getPolygonQuoteMock: vi.fn(),
  yahooGetMock: vi.fn(),
  fetchPolygonAggsMock: vi.fn(),
  getMarketSessionMock: vi.fn(),
  getMarketSessionForTickerMock: vi.fn(),
  tradesOnWeekendsMock: vi.fn(() => false),
  tradesWithinEtCalendarDayMock: vi.fn(() => true),
}));

vi.mock('../utils/finnhub', () => ({
  getQuote: getQuoteMock,
  getQuotes: getQuotesMock,
  searchSymbols: searchSymbolsMock,
  getStockProfile: getStockProfileMock,
  getStockMetrics: getStockMetricsMock,
}));

vi.mock('../utils/polygon', () => ({
  getPolygonQuotes: getPolygonQuotesMock,
  getPolygonQuote: getPolygonQuoteMock,
}));

vi.mock('../utils/yahoo-http', () => ({
  yahooGet: yahooGetMock,
  fetchPolygonAggs: fetchPolygonAggsMock,
}));

vi.mock('../utils/market-hours', () => ({
  getMarketSession: getMarketSessionMock,
  getMarketSessionForTicker: getMarketSessionForTickerMock,
  tradesOnWeekends: tradesOnWeekendsMock,
  tradesWithinEtCalendarDay: tradesWithinEtCalendarDayMock,
}));

import { fetchStockDetails, fetchPrices, fetchIntradayCandles, fetchHourlyCandles, STOCK_DETAILS_OPTIONAL_TIMEOUT_MS, TickerNotFoundError } from '../services/market.service';

describe('market.service fetchPrices — Yahoo confirmation clears false staleness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    getMarketSessionMock.mockReturnValue('POST');
    getMarketSessionForTickerMock.mockReturnValue('POST');
    getQuotesMock.mockResolvedValue({ quotes: new Map(), staleCount: 0, repricingCount: 0, failedTickers: [], provider: 'finnhub' });
  });

  // An aged Polygon cache entry during POST: real price, but flagged stale/repricing
  // because getPolygonQuotes saw it was >30min old.
  const agedPolygonQuote = (ticker: string) => ({
    quotes: new Map([[ticker, {
      ticker, currentPrice: 255, previousClose: 250, change: 5, changePercent: 2,
      high: 256, low: 254, open: 250, timestamp: 1, updatedAt: 1,
      isStale: true, isRepricing: true, quoteAgeSeconds: 4200, session: 'POST',
    }]]),
    staleCount: 1, repricingCount: 1, failedTickers: [] as string[], provider: 'polygon',
  });

  it('clears isStale/isRepricing and zeroes the counts when a fresh Yahoo quote CONFIRMS an aged Polygon price within tolerance (POST)', async () => {
    getPolygonQuotesMock.mockResolvedValue(agedPolygonQuote('AAPL'));
    // Yahoo POST price 255.5 vs Polygon 255 = ~0.2% divergence -> confirm, do NOT overwrite.
    yahooGetMock.mockResolvedValue({ data: { quoteResponse: { result: [{
      symbol: 'AAPL', marketState: 'POST', regularMarketPreviousClose: 250,
      regularMarketPrice: 250, postMarketPrice: 255.5,
    }] } } });

    const result = await fetchPrices(['AAPL']);
    const quote = result.quotes.get('AAPL')!;

    expect(quote.isStale).toBe(false);
    expect(quote.isRepricing).toBe(false);
    expect(quote.currentPrice).toBe(255); // within tolerance -> price NOT overwritten
    expect(result.staleCount).toBe(0);
    expect(result.repricingCount).toBe(0);
  });

  it('leaves the quote stale/repricing when Yahoo has no fresh price to confirm it (never masks a real outage)', async () => {
    // Guard, not a revert-catch: with no Yahoo data the overlay never touches the quote, so
    // Polygon's flags/counts pass through unchanged with or without the fix. It pins the
    // safety invariant — staleness only ever clears on a real confirmation, never otherwise.
    getPolygonQuotesMock.mockResolvedValue(agedPolygonQuote('NVDA'));
    yahooGetMock.mockResolvedValue({ data: { quoteResponse: { result: [] } } }); // Yahoo returns nothing usable

    const result = await fetchPrices(['NVDA']);
    const quote = result.quotes.get('NVDA')!;

    expect(quote.isStale).toBe(true);
    expect(quote.isRepricing).toBe(true);
    expect(result.staleCount).toBe(1);
    expect(result.repricingCount).toBe(1);
  });
});

describe('market.service fetchStockDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    getMarketSessionMock.mockReturnValue('REG');
    getMarketSessionForTickerMock.mockReturnValue('REG');
    getPolygonQuoteMock.mockRejectedValue(new Error('polygon down'));
    getQuoteMock.mockRejectedValue(new Error('finnhub down'));
    yahooGetMock.mockResolvedValue({
      data: {
        chart: {
          result: [{
            meta: {
              regularMarketPrice: 100,
              regularMarketDayHigh: 103,
              regularMarketDayLow: 98,
              regularMarketOpen: 99,
              chartPreviousClose: 97,
            },
            timestamp: [1, 2],
            indicators: {
              quote: [{
                close: [99, 100],
              }],
            },
          }],
        },
      },
    });

    getStockProfileMock.mockImplementation(() => new Promise(() => undefined));
    getStockMetricsMock.mockImplementation(() => new Promise(() => undefined));
    fetchPolygonAggsMock.mockImplementation(() => new Promise(() => undefined));
  });

  it('returns quote data promptly even when profile, metrics, and candles stall', async () => {
    const pending = fetchStockDetails('NOW');

    await vi.advanceTimersByTimeAsync(STOCK_DETAILS_OPTIONAL_TIMEOUT_MS + 5);

    await expect(pending).resolves.toEqual(expect.objectContaining({
      ticker: 'NOW',
      quote: expect.objectContaining({
        ticker: 'NOW',
        currentPrice: 100,
        previousClose: 97,
      }),
      profile: null,
      metrics: null,
      candles: null,
    }));
  });

  describe('no-quote disambiguation (unknown symbol → 404 vs transient outage → retryable 5xx)', () => {
    // Resolve the no-quote branch: every provider fails AND Yahoo returns no
    // usable meta → quote is null. Then advance past the optional soft-timeouts
    // (profile/metrics/candles stay pending) so fetchStockDetails reaches the
    // disambiguation, and read the rejection.
    const resolveNoQuote = async (ticker: string) => {
      yahooGetMock.mockResolvedValue({ data: { chart: { result: [{ meta: {} }] } } });
      const p = fetchStockDetails(ticker).catch((e) => e);
      await vi.advanceTimersByTimeAsync(STOCK_DETAILS_OPTIONAL_TIMEOUT_MS + 5);
      return p;
    };

    it('throws TickerNotFoundError when a COMPLETE search finds no exact match', async () => {
      // partial:false = the search ran cleanly; empty results = symbol unknown.
      searchSymbolsMock.mockResolvedValue({ results: [], partial: false, cached: false, advPending: [] });
      expect(await resolveNoQuote('FAKEXYZ')).toBeInstanceOf(TickerNotFoundError);
    });

    it('does NOT 404 (throws a retryable error) when the search itself is PARTIAL', async () => {
      // partial:true = search providers failed; results are unreliable, so an
      // empty list must not be read as "no such symbol" (the cold-cache
      // real-ticker-during-outage regression).
      searchSymbolsMock.mockResolvedValue({ results: [], partial: true, cached: false, advPending: [] });
      const err = await resolveNoQuote('AAPL');
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TickerNotFoundError);
    });

    it('does NOT 404 when a complete search DOES return the exact symbol (real ticker, transient quote outage)', async () => {
      searchSymbolsMock.mockResolvedValue({
        results: [{ symbol: 'AAPL', description: 'Apple Inc', type: 'stock', primaryExchange: 'XNAS', popularityScore: 1 }],
        partial: false, cached: false, advPending: [],
      });
      const err = await resolveNoQuote('AAPL');
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TickerNotFoundError);
    });

    it('matches the exact symbol case-insensitively', async () => {
      searchSymbolsMock.mockResolvedValue({
        results: [{ symbol: 'aapl', description: 'Apple Inc', type: 'stock', primaryExchange: 'XNAS', popularityScore: 1 }],
        partial: false, cached: false, advPending: [],
      });
      expect(await resolveNoQuote('AAPL')).not.toBeInstanceOf(TickerNotFoundError);
    });
  });
});

// Regression: on 2026-08-12 Polygon carried no DE bars for the open session while
// Yahoo did. Both candle paths picked Polygon anyway — the 1D chart by bar count
// (a complete Aug-11 session outvoted a partial live one), the multi-day charts
// because a non-empty Polygon response short-circuited the Yahoo fallback. Result:
// yesterday's session rendered under today's live quote.
describe('market.service candle sources — freshness beats bar count', () => {
  // Wall-clock-derived dates make these tests flaky (epoch arithmetic skips an
  // hour across the November DST fall-back, and a run straddling ET midnight
  // disagrees with the service's own etDate()). Pin the clock instead — the
  // stale/fresh rules are explicitly time-of-day dependent, so each test states
  // the ET moment it is describing. Only Date is faked; timers stay real.
  const TODAY = '2026-08-12';     // Wednesday
  const YESTERDAY = '2026-08-11'; // Tuesday
  const setNow = (iso: string) => vi.setSystemTime(new Date(iso));

  // 14:00Z is mid-morning ET under both EST and EDT, so `count` 5-min bars from
  // there never spill into the next ET calendar day.
  const barTimes = (day: string, count: number): number[] => {
    const start = Date.parse(`${day}T14:00:00.000Z`);
    return Array.from({ length: count }, (_, i) => Math.floor((start + i * 300_000) / 1000));
  };

  const polygonBars = (day: string, count: number, close: number) => {
    const timestamps = barTimes(day, count);
    const flat = timestamps.map(() => close);
    return { timestamps, closes: flat, highs: flat, lows: flat, opens: flat, volumes: timestamps.map(() => 1000) };
  };

  const yahooResponse = (timestamp: number[], close: number) => {
    const flat = timestamp.map(() => close);
    const quote = { open: flat, high: flat, low: flat, close: flat, volume: timestamp.map(() => 1000) };
    return { data: { chart: { result: [{ timestamp, indicators: { quote: [quote] } }] } } };
  };

  const yahooBars = (day: string, count: number, close: number) => yahooResponse(barTimes(day, count), close);

  const etDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const daysOf = (candles: { time: string }[]): string[] =>
    [...new Set(candles.map(c => etDayFmt.format(new Date(c.time))))];

  // Defaults describe a plain US equity. The real predicates are covered
  // unmocked in market-hours.ticker-calendar.test.ts.
  let warnSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    setNow(`${TODAY}T13:40:00.000Z`); // 9:40 AM ET, mid-REG — when DE was reported
    getMarketSessionMock.mockReturnValue('REG');
    getMarketSessionForTickerMock.mockReturnValue('REG');
    tradesOnWeekendsMock.mockReturnValue(false);
    tradesWithinEtCalendarDayMock.mockReturnValue(true);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('1D: keeps the live session even when a stale source has far more bars', async () => {
    fetchPolygonAggsMock.mockResolvedValue(polygonBars(YESTERDAY, 80, 617.95));
    yahooGetMock.mockResolvedValue(yahooBars(TODAY, 30, 621.08));

    const candles = await fetchIntradayCandles('FRESHA');

    expect(daysOf(candles)).toEqual([TODAY]);
    expect(candles).toHaveLength(30);
    expect(candles[candles.length - 1].close).toBe(621.08);
  });

  it('1D: still prefers the longer series when both sources are on the same day (pre-market coverage)', async () => {
    fetchPolygonAggsMock.mockResolvedValue(polygonBars(TODAY, 80, 100));
    yahooGetMock.mockResolvedValue(yahooBars(TODAY, 30, 200));

    const candles = await fetchIntradayCandles('FRESHB');

    expect(candles).toHaveLength(80);
    expect(candles[0].close).toBe(100);
  });

  it('1D: uses Yahoo when Polygon returns nothing at all', async () => {
    fetchPolygonAggsMock.mockResolvedValue(null);
    yahooGetMock.mockResolvedValue(yahooBars(TODAY, 12, 621.08));

    const candles = await fetchIntradayCandles('FRESHE');

    expect(daysOf(candles)).toEqual([TODAY]);
    expect(candles).toHaveLength(12);
  });

  it('1D: both sources stuck on the prior session returns the longer one', async () => {
    setNow('2026-08-19T14:00:00.000Z'); // Wednesday 10:00 ET
    fetchPolygonAggsMock.mockResolvedValue(polygonBars('2026-08-18', 80, 617.95));
    yahooGetMock.mockResolvedValue(yahooBars('2026-08-18', 30, 617.95));

    const candles = await fetchIntradayCandles('FRESHF');

    expect(daysOf(candles)).toEqual(['2026-08-18']);
    expect(candles).toHaveLength(80);
  });

  it('stale alert stays quiet for one lagging ticker and fires once several agree', async () => {
    // One stale symbol is a delisted holding or a foreign listing on its own
    // market's holiday. Several on the same expected session is a real stall.
    // Its own ET day, so no other test can consume this day's single alert.
    setNow('2026-08-20T14:00:00.000Z'); // Thursday 10:00 ET
    fetchPolygonAggsMock.mockResolvedValue(polygonBars('2026-08-19', 20, 100));
    yahooGetMock.mockResolvedValue(yahooBars('2026-08-19', 5, 100));

    await fetchIntradayCandles('STALE1');
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('candles are stale'));

    await fetchIntradayCandles('STALE2');
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('candles are stale'));

    await fetchIntradayCandles('STALE3');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('candles are stale for 3+ tickers (STALE1, STALE2, STALE3) — STALE3 1D newest bar is 2026-08-19, expected 2026-08-20'),
    );

    // Fourth ticker on the same day adds nothing to the log.
    const before = warnSpy.mock.calls.length;
    await fetchIntradayCandles('STALE4');
    expect(warnSpy.mock.calls.length).toBe(before);
  });

  it('hourly: grafts the live session onto Polygon history without truncating it', async () => {
    setNow(`${TODAY}T14:00:00.000Z`); // 10:00 AM ET — past the point today should have bars
    // The M3 shape: Yahoo is fresher but far shorter. Swapping wholesale would
    // trade months of history for one session.
    fetchPolygonAggsMock.mockResolvedValue(polygonBars(YESTERDAY, 80, 617.95));
    yahooGetMock.mockResolvedValue(yahooBars(TODAY, 3, 621.08));

    const candles = await fetchHourlyCandles('FRESHC', '1W');

    expect(candles).toHaveLength(83);
    expect(daysOf(candles)).toEqual([YESTERDAY, TODAY]);
    expect(candles[0].close).toBe(617.95);
    expect(candles[candles.length - 1].close).toBe(621.08);
  });

  it('hourly: a fallback that reaches no further than Polygon leaves the series untouched', async () => {
    setNow(`${TODAY}T14:00:00.000Z`);
    fetchPolygonAggsMock.mockResolvedValue(polygonBars(YESTERDAY, 80, 617.95));
    yahooGetMock.mockResolvedValue(yahooBars(YESTERDAY, 5, 999));

    const candles = await fetchHourlyCandles('FRESHG', '1W');

    expect(candles).toHaveLength(80);
    expect(candles.every(c => c.close === 617.95)).toBe(true);
  });

  it('hourly: pre-market has no bars yet, so Polygon is trusted without a Yahoo call', async () => {
    setNow(`${TODAY}T12:00:00.000Z`); // 8:00 AM ET
    fetchPolygonAggsMock.mockResolvedValue(polygonBars(YESTERDAY, 80, 617.95));

    const candles = await fetchHourlyCandles('FRESHD', '1W');

    expect(daysOf(candles)).toEqual([YESTERDAY]);
    expect(yahooGetMock).not.toHaveBeenCalled();
  });

  it('hourly: on a weekend the prior session IS current — no fallback fetch', async () => {
    setNow('2026-08-15T16:00:00.000Z'); // Saturday noon ET
    fetchPolygonAggsMock.mockResolvedValue(polygonBars('2026-08-14', 80, 617.95));

    const candles = await fetchHourlyCandles('FRESHH', '1W');

    expect(daysOf(candles)).toEqual(['2026-08-14']);
    expect(yahooGetMock).not.toHaveBeenCalled();
  });

  it('1D: prefers Polygon when IT is the source holding the later day', async () => {
    fetchPolygonAggsMock.mockResolvedValue(polygonBars(TODAY, 20, 621.08));
    yahooGetMock.mockResolvedValue(yahooBars(YESTERDAY, 80, 617.95));

    const candles = await fetchIntradayCandles('FRESHJ');

    expect(daysOf(candles)).toEqual([TODAY]);
    expect(candles).toHaveLength(20);
  });

  it('1D: trims a fallback response that straddles two ET days down to the live session', async () => {
    // Yahoo's range=1d can carry the tail of the prior session around the open,
    // and getIntraday anchors the chart on yesterday's close — so those bars
    // would be drawn against the wrong baseline.
    fetchPolygonAggsMock.mockResolvedValue(null);
    yahooGetMock.mockResolvedValue(yahooResponse([...barTimes(YESTERDAY, 5), ...barTimes(TODAY, 4)], 621.08));

    const candles = await fetchIntradayCandles('FRESHK');

    expect(daysOf(candles)).toEqual([TODAY]);
    expect(candles).toHaveLength(4);
  });

  it('hourly: a failing fallback leaves Polygon serving the chart', async () => {
    setNow(`${TODAY}T14:00:00.000Z`);
    fetchPolygonAggsMock.mockResolvedValue(polygonBars(YESTERDAY, 80, 617.95));
    yahooGetMock.mockRejectedValue(new Error('blocked from datacenter IP'));

    const candles = await fetchHourlyCandles('FRESHL', '1W');

    expect(candles).toHaveLength(80);
    expect(daysOf(candles)).toEqual([YESTERDAY]);
  });

  it('hourly: overnight, a source that missed the entire previous session is still stale', async () => {
    // The window the first cut of this fix got wrong: between ET midnight and
    // 9:50 the staleness rule went inert, so a source two sessions behind read
    // as current until mid-morning.
    setNow('2026-08-13T05:00:00.000Z'); // Thursday 01:00 ET
    fetchPolygonAggsMock.mockResolvedValue(polygonBars('2026-08-11', 80, 610)); // Tuesday — missed Wednesday
    yahooGetMock.mockResolvedValue(yahooBars('2026-08-12', 6, 621.08));         // Wednesday

    const candles = await fetchHourlyCandles('FRESHM', '1W');

    expect(daysOf(candles)).toEqual(['2026-08-11', '2026-08-12']);
    expect(candles).toHaveLength(86);
  });

  it('hourly: after a weekday session closes, a source that missed the whole day is still stale', async () => {
    setNow(`${TODAY}T01:00:00.000Z`); // 2026-08-11 21:00 ET — Tuesday evening, after the close
    fetchPolygonAggsMock.mockResolvedValue(polygonBars('2026-08-10', 80, 610));
    yahooGetMock.mockResolvedValue(yahooBars('2026-08-11', 4, 617.95));

    const candles = await fetchHourlyCandles('FRESHI', '1W');

    expect(daysOf(candles)).toEqual(['2026-08-10', '2026-08-11']);
    expect(candles[candles.length - 1].close).toBe(617.95);
  });

  it('hourly: 9:49 ET trusts Polygon, 9:50 ET does not — the boundary the whole rule turns on', async () => {
    fetchPolygonAggsMock.mockResolvedValue(polygonBars(YESTERDAY, 80, 617.95));
    yahooGetMock.mockResolvedValue(yahooBars(TODAY, 6, 621.08));

    setNow(`${TODAY}T13:49:59.000Z`); // 9:49:59 ET — today needn't have printed yet
    expect(daysOf(await fetchHourlyCandles('FRESHN', '1W'))).toEqual([YESTERDAY]);
    expect(yahooGetMock).not.toHaveBeenCalled();

    setNow(`${TODAY}T13:50:00.000Z`); // 9:50:00 ET — now it should have
    expect(daysOf(await fetchHourlyCandles('FRESHO', '1W'))).toEqual([YESTERDAY, TODAY]);
    expect(yahooGetMock).toHaveBeenCalled();
  });

  it('hourly: with nothing from Polygon the fallback stands alone', async () => {
    setNow(`${TODAY}T14:00:00.000Z`);
    fetchPolygonAggsMock.mockResolvedValue(null);
    yahooGetMock.mockResolvedValue(yahooBars(TODAY, 40, 621.08));

    const candles = await fetchHourlyCandles('FRESHP', '1W');

    expect(candles).toHaveLength(40);
    expect(daysOf(candles)).toEqual([TODAY]);
  });

  it('hourly: a weekend-trading ticker is measured against today, not last Friday', async () => {
    // The 24/7 branch: a market that never closes has no "previous session" to
    // fall back on, so a source stuck on Friday is stale all Monday morning.
    setNow('2026-08-17T10:00:00.000Z'); // Monday 06:00 ET
    tradesOnWeekendsMock.mockReturnValue(true);
    fetchPolygonAggsMock.mockResolvedValue(polygonBars('2026-08-14', 80, 610)); // Friday
    yahooGetMock.mockResolvedValue(yahooBars('2026-08-16', 12, 621.08));        // Sunday

    const candles = await fetchHourlyCandles('FRESHQ', '1W');

    expect(daysOf(candles)).toEqual(['2026-08-14', '2026-08-16']);
    expect(candles).toHaveLength(92);
  });

  it('1D: compares like with like — a straddling fallback cannot win the count on bars it will not show', async () => {
    // Yahoo's raw 9 bars beat Polygon's 6, but 5 of them belong to the prior
    // session. Trimming after the tie-break instead of before would serve a
    // 4-bar chart where a 6-bar one was available.
    fetchPolygonAggsMock.mockResolvedValue(polygonBars(TODAY, 6, 100));
    yahooGetMock.mockResolvedValue(yahooResponse([...barTimes(YESTERDAY, 5), ...barTimes(TODAY, 4)], 200));

    const candles = await fetchIntradayCandles('FRESHS');

    expect(candles).toHaveLength(6);
    expect(candles[0].close).toBe(100);
  });

  it('1D: leaves a session that legitimately straddles ET midnight intact', async () => {
    // Crypto, futures and Asia-Pacific listings open the previous evening in ET;
    // trimming them to one ET date would cut off the start of the session.
    tradesWithinEtCalendarDayMock.mockReturnValue(false);
    fetchPolygonAggsMock.mockResolvedValue(null);
    yahooGetMock.mockResolvedValue(yahooResponse([...barTimes(YESTERDAY, 5), ...barTimes(TODAY, 4)], 621.08));

    const candles = await fetchIntradayCandles('FRESHR');

    expect(daysOf(candles)).toEqual([YESTERDAY, TODAY]);
    expect(candles).toHaveLength(9);
  });
});
