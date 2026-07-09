import { describe, expect, it } from 'vitest';
import { computeRiskTemperatureFromCandles } from '../services/risk-temperature.service';

// Server-side port of the WarningPanel risk engine. These fixtures lock the
// headline behaviors so the canonical numbers can't drift from the design:
// a clean uptrend reads calm, a deep decline trips the correction/death-cross/
// drawdown alarms, and <200 days yields no metrics at all.

function uptrendCandles(days: number) {
  // Rising ~0.1%/day with a mild deterministic wiggle through history and a
  // perfectly calm final 40 days. The wiggle matters: an all-identical-returns
  // series makes every percentile a floating-point tie-break (arbitrary rank);
  // varied history + a calm recent window gives deterministic LOW readings.
  const closes: number[] = [];
  let p = 100;
  for (let i = 0; i < days; i++) {
    const wiggle = i < days - 40 ? 0.004 * Math.sin(i * 1.7) : 0;
    p *= 1 + 0.001 + wiggle;
    closes.push(p);
  }
  const opens = [closes[0], ...closes.slice(0, -1)];
  const volumes = new Array(days).fill(1_000_000);
  return { closes, opens, volumes };
}

function crashCandles(riseDays: number, fallDays: number) {
  const closes: number[] = [];
  let p = 100;
  for (let i = 0; i < riseDays; i++) {
    p *= 1.001;
    closes.push(p);
  }
  for (let i = 0; i < fallDays; i++) {
    p *= 0.995; // −0.5%/day
    closes.push(p);
  }
  const opens = [closes[0], ...closes.slice(0, -1)];
  const volumes = new Array(closes.length).fill(1_000_000);
  return { closes, opens, volumes };
}

describe('computeRiskTemperatureFromCandles — canonical per-stock risk engine', () => {
  it('reads calm on a clean 500-day uptrend', () => {
    const m = computeRiskTemperatureFromCandles(uptrendCandles(500));
    expect(m).not.toBeNull();
    expect(m!.trendBreak?.value).toBe('Healthy Uptrend');
    expect(m!.trendBreak?.level).toBe('low');
    expect(m!.correction?.value).toBe('At Peak');
    expect(m!.drawdown?.value).toBe('0.0%');
    expect(m!.drawdown?.level).toBe('low');
    expect(m!.distribution?.value).toBe('0');
    expect(m!.distribution?.level).toBe('low');
    expect(m!.temperature).not.toBeNull();
    expect(m!.temperature!.level).toBe('low');
    const score = parseFloat(m!.temperature!.value);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThan(50);
  });

  it('trips correction / death cross / drawdown alarms on a deep decline', () => {
    // 400 up days then 100 days of −0.5%/day ≈ −39% from peak
    const m = computeRiskTemperatureFromCandles(crashCandles(400, 100));
    expect(m).not.toBeNull();
    expect(m!.correction?.value).toBe('30% IN PROGRESS');
    expect(m!.correction?.level).toBe('high');
    expect(m!.trendBreak?.value).toBe('Death Cross Active');
    expect(m!.trendBreak?.level).toBe('high');
    expect(m!.drawdown?.level).toBe('high');
    expect(parseFloat(m!.drawdown!.value)).toBeLessThan(-30);
    const score = parseFloat(m!.temperature!.value);
    expect(score).toBeGreaterThan(50);
    expect(m!.temperature!.level).not.toBe('low');
  });

  it('returns null (unavailable) with fewer than 200 daily candles', () => {
    expect(computeRiskTemperatureFromCandles(uptrendCandles(150))).toBeNull();
  });
});
