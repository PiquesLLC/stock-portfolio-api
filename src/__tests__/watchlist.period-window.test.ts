import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression: watchlist period returns must be anchored by DATE (first candle within
// the window), not by a fixed trading-bar count — otherwise "1W" drifts past 7
// calendar days across holidays and disagrees with the heatmap / stock chart.

const mocks = vi.hoisted(() => ({ fetchPolygonAggs: vi.fn() }));
vi.mock('../utils/yahoo-http', () => ({ fetchPolygonAggs: mocks.fetchPolygonAggs }));

const DAY = 86_400_000;
const secAgo = (days: number) => Math.floor((Date.now() - days * DAY) / 1000);

describe('watchlist fetchTickerPerf — windows are date-anchored, not fixed bar counts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('weekChangePercent anchors at the ~7-day-ago candle, even across an irregular gap', async () => {
    // Bars at these days-ago with holiday-style gaps. The OLD bug used closes[len-6]
    // (= $200, ~20 days ago) for "week"; the true 7-day window starts at the 5-day-ago
    // bar ($100). End is the latest bar ($110).
    const timestamps = [30, 25, 20, 15, 10, 5, 2, 0].map(secAgo);
    const closes = [200, 195, 200, 150, 120, 100, 105, 110];
    mocks.fetchPolygonAggs.mockResolvedValue({
      timestamps, closes, opens: closes, highs: closes, lows: closes, volumes: closes.map(() => 1),
    } as any);

    const { fetchTickerPerf } = await import('../services/watchlist.service');
    const perf = await fetchTickerPerf('AMZN');

    // True 1W: (110 - 100)/100 = +10%. The fixed-bar bug would give (110-200)/200 = -45%.
    expect(perf.weekChangePercent).toBeCloseTo(10, 1);
    expect(perf.weekChangePercent).toBeGreaterThan(0);
  });

  it('monthChangePercent anchors at the ~30-day-ago candle (not a fixed 21-bar offset)', async () => {
    // First bar is 40 days ago ($300) — outside the 30-day window; the 28-day-ago bar
    // ($250) is the true month start. Old bug used closes[len-22] which, with few bars,
    // clamps to closes[0] (=$300, 40 days ago).
    const timestamps = [40, 28, 20, 10, 3, 0].map(secAgo);
    const closes = [300, 250, 240, 230, 245, 255];
    mocks.fetchPolygonAggs.mockResolvedValue({
      timestamps, closes, opens: closes, highs: closes, lows: closes, volumes: closes.map(() => 1),
    } as any);

    const { fetchTickerPerf } = await import('../services/watchlist.service');
    const perf = await fetchTickerPerf('AMZN');

    // True 1M: (255 - 250)/250 = +2%. The clamped-bar bug would give (255-300)/300 = -15%.
    expect(perf.monthChangePercent).toBeCloseTo(2, 1);
  });
});
