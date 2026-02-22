import { describe, it, expect } from 'vitest';

/**
 * Extracted scaling logic matching portfolio.controller.ts getChartHandler.
 * Uses median of last 5 points as anchor, clamps scale to [0.97, 1.03].
 */
function applyScaling(
  pointValues: number[],
  liveVal: number,
): { scaled: number[]; rawScale: number; appliedScale: number; clamped: boolean } {
  const anchorWindow = pointValues.slice(-Math.min(5, pointValues.length));
  const sortedAnchor = [...anchorWindow].sort((a, b) => a - b);
  const anchorVal = sortedAnchor[Math.floor(sortedAnchor.length / 2)]; // median

  const rawScale = liveVal / anchorVal;
  const appliedScale = Math.max(0.97, Math.min(1.03, rawScale));
  const clamped = Math.abs(rawScale - appliedScale) > 0.001;

  const scaled = pointValues.map(v => v * appliedScale);
  return { scaled, rawScale, appliedScale, clamped };
}

describe('Scaling anchor (median of last 5 + clamp)', () => {
  it('uses median of last 5 points, not the last point', () => {
    // Last point is an outlier (470k), but median of last 5 is ~502k
    const points = [500000, 501000, 502000, 503000, 470000];
    const liveVal = 505000;

    const { rawScale, appliedScale, clamped } = applyScaling(points, liveVal);

    // Median of [500000, 501000, 502000, 503000, 470000] sorted = [470000, 500000, 501000, 502000, 503000]
    // Median = 501000
    // rawScale = 505000 / 501000 = 1.00798...
    expect(rawScale).toBeCloseTo(505000 / 501000, 4);
    expect(clamped).toBe(false);
    expect(appliedScale).toBeCloseTo(rawScale, 4);
  });

  it('clamps scale to 1.03 when raw scale exceeds upper bound', () => {
    // All points around 480k, live is 505k => ~1.052 raw scale
    const points = [480000, 479000, 481000, 480000, 478000];
    const liveVal = 505000;

    const { rawScale, appliedScale, clamped } = applyScaling(points, liveVal);

    expect(rawScale).toBeGreaterThan(1.03);
    expect(appliedScale).toBe(1.03);
    expect(clamped).toBe(true);
  });

  it('clamps scale to 0.97 when raw scale is below lower bound', () => {
    // Points around 520k, live is 490k => ~0.942 raw scale
    const points = [520000, 521000, 519000, 520000, 522000];
    const liveVal = 490000;

    const { rawScale, appliedScale, clamped } = applyScaling(points, liveVal);

    expect(rawScale).toBeLessThan(0.97);
    expect(appliedScale).toBe(0.97);
    expect(clamped).toBe(true);
  });

  it('does not clamp when scale is within bounds', () => {
    const points = [500000, 501000, 502000, 503000, 504000];
    const liveVal = 505000;

    const { rawScale, appliedScale, clamped } = applyScaling(points, liveVal);

    expect(rawScale).toBeGreaterThan(0.97);
    expect(rawScale).toBeLessThan(1.03);
    expect(clamped).toBe(false);
    expect(appliedScale).toBeCloseTo(rawScale, 6);
  });

  it('preserves relative chart shape after scaling', () => {
    const points = [500000, 510000, 505000, 515000, 520000];
    const liveVal = 525000;

    const { scaled } = applyScaling(points, liveVal);

    // Relative ratios should be preserved
    const originalRatio = points[1] / points[0];
    const scaledRatio = scaled[1] / scaled[0];
    expect(scaledRatio).toBeCloseTo(originalRatio, 6);
  });

  it('handles single-point array', () => {
    const points = [500000];
    const liveVal = 505000;

    const { rawScale, appliedScale } = applyScaling(points, liveVal);

    expect(rawScale).toBeCloseTo(1.01, 2);
    expect(appliedScale).toBeCloseTo(rawScale, 4);
  });

  it('handles fewer than 5 points', () => {
    const points = [500000, 505000, 503000];
    const liveVal = 506000;

    const { rawScale } = applyScaling(points, liveVal);

    // Median of 3 = middle value = 503000
    expect(rawScale).toBeCloseTo(506000 / 503000, 4);
  });
});
