import { describe, it, expect } from 'vitest';
import { toCents, fromCents, valueToCents, sumCents } from '../utils/money';

describe('money helpers (cents migration foundation)', () => {
  it('toCents rounds dollars to integer cents (incl. float drift)', () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0)).toBe(0);
    expect(toCents(100)).toBe(10000);
    expect(toCents(1234.56)).toBe(123456);
    expect(toCents(0.01)).toBe(1);
    expect(toCents(0.1 + 0.2)).toBe(30); // 0.30000000000000004 → 30, not 30.0000…
  });

  it('toCents handles negatives symmetrically', () => {
    expect(toCents(-5.5)).toBe(-550);
    expect(toCents(-1234.56)).toBe(-123456);
    expect(toCents(-0.01)).toBe(-1);
  });

  it('toCents never propagates NaN / Infinity into money', () => {
    expect(toCents(NaN)).toBe(0);
    expect(toCents(Infinity)).toBe(0);
    expect(toCents(-Infinity)).toBe(0);
  });

  it('fromCents converts integer cents back to dollars', () => {
    expect(fromCents(1999)).toBe(19.99);
    expect(fromCents(0)).toBe(0);
    expect(fromCents(-550)).toBe(-5.5);
  });

  it('round-trips dollars → cents → dollars', () => {
    for (const d of [0, 1, 19.99, 1234.56, 0.01, 999999.99]) {
      expect(fromCents(toCents(d))).toBeCloseTo(d, 2);
    }
  });

  it('valueToCents computes market value from fractional shares × per-share price', () => {
    expect(valueToCents(1.5, 10)).toBe(1500);     // 15.00
    expect(valueToCents(3, 19.999)).toBe(6000);   // 59.997 → 6000c
    expect(valueToCents(0, 100)).toBe(0);
  });

  it('sumCents adds integer cents and guards drift', () => {
    expect(sumCents([100, 200, 1999])).toBe(2299);
    expect(sumCents([])).toBe(0);
    expect(sumCents([-550, 550])).toBe(0);
  });
});
