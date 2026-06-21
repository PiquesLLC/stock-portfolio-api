import { describe, it, expect } from 'vitest';
import { deriveHeatmapQuoteFields } from '../utils/heatmap-quote';

describe('deriveHeatmapQuoteFields', () => {
  it('extended POST: change is the total move from previousClose; regular splits out the regular-session move', () => {
    // GOOGL: closed -0.16% regular, then +7% after-hours on earnings (mirrors the
    // market-heatmap extended-hours test so themes/ETF behave identically).
    const f = deriveHeatmapQuoteFields({
      currentPrice: 99.84,
      previousClose: 100,
      change: -0.16,
      changePercent: -0.16,
      extendedPrice: 106.84,
      extendedChangePercent: 7.01,
    });
    expect(f.source).toBe('extended');
    // Default (AH-inclusive) value — preserved from the old inline behavior.
    expect(f.changePercent).toBeCloseTo(6.84, 2);
    expect(f.price).toBe(106.84);
    // Toggle target — the regular-session close, NOT quote.changePercent.
    expect(f.regularChangePercent).toBeCloseTo(-0.16, 2);
    expect(f.regularPrice).toBe(99.84);
  });

  it('no extended print: regular equals the change and price is the regular price', () => {
    const f = deriveHeatmapQuoteFields({
      currentPrice: 101.5,
      previousClose: 100,
      change: 1.5,
      changePercent: 1.5,
    });
    expect(f.source).toBe('regular');
    expect(f.changePercent).toBeCloseTo(1.5, 2);
    expect(f.regularChangePercent).toBeCloseTo(1.5, 2);
    expect(f.price).toBe(101.5);
    expect(f.regularPrice).toBe(101.5);
  });

  it('prevClose fallback: no real trade (price == previousClose, zero change)', () => {
    const f = deriveHeatmapQuoteFields({
      currentPrice: 100,
      previousClose: 100,
      change: 0,
      changePercent: 0,
    });
    expect(f.source).toBe('prevClose');
    expect(f.changePercent).toBe(0);
    expect(f.regularChangePercent).toBe(0);
  });

  it('extended print but previousClose <= 0: cannot anchor, both fall back to changePercent', () => {
    const f = deriveHeatmapQuoteFields({
      currentPrice: 50,
      previousClose: 0,
      change: 0,
      changePercent: 2.5,
      extendedPrice: 52,
      extendedChangePercent: 4,
    });
    // hasExtended is true so price still shows the extended print...
    expect(f.price).toBe(52);
    expect(f.source).toBe('extended');
    // ...but with no valid previousClose, change math can't run → quote.changePercent,
    // and regular mirrors it (no safe regular anchor).
    expect(f.changePercent).toBeCloseTo(2.5, 2);
    expect(f.regularChangePercent).toBeCloseTo(2.5, 2);
    expect(f.regularPrice).toBe(50);
  });

  it('regular and extended diverge in sign when AH reverses the regular move', () => {
    // Regular session down, after-hours rips it green — the toggle must show both truthfully.
    const f = deriveHeatmapQuoteFields({
      currentPrice: 95,
      previousClose: 100,
      change: -5,
      changePercent: -5,
      extendedPrice: 104,
      extendedChangePercent: 9.47,
    });
    expect(f.changePercent).toBeCloseTo(4, 2);        // +4% AH-inclusive
    expect(f.regularChangePercent).toBeCloseTo(-5, 2); // -5% regular
    expect(f.changePercent).toBeGreaterThan(0);
    expect(f.regularChangePercent).toBeLessThan(0);
  });
});
