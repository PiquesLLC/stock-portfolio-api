import { describe, it, expect } from 'vitest';
import { annualByPeriodEnd, valueForPeriod, type EdgarFact } from '../services/sec-edgar.service';

const fact = (o: Partial<EdgarFact> & { end: string; val: number }): EdgarFact => ({
  start: o.start ?? '2023-01-01',
  form: o.form ?? '10-K',
  filed: o.filed ?? '2024-02-01',
  ...o,
});

describe('annualByPeriodEnd', () => {
  it('keeps annual durations and drops quarterly and year-to-date stubs', () => {
    const out = annualByPeriodEnd([
      fact({ start: '2023-01-01', end: '2023-12-31', val: 1000 }),   // 364d — annual
      fact({ start: '2023-10-01', end: '2023-12-31', val: 250 }),    // 91d  — Q4
      fact({ start: '2023-01-01', end: '2023-09-30', val: 750 }),    // 272d — YTD
    ]);
    expect(out.size).toBe(1);
    expect(out.get('2023-12-31')).toBe(1000);
  });

  it('ignores anything not filed on an annual report form', () => {
    // A 10-Q can carry a trailing-twelve-month duration; it must not count as a year.
    const out = annualByPeriodEnd([
      fact({ start: '2023-01-01', end: '2023-12-31', val: 999, form: '10-Q' }),
      fact({ start: '2023-01-01', end: '2023-12-31', val: 1000, form: '10-K/A' }),
    ]);
    expect(out.get('2023-12-31')).toBe(1000);
  });

  it('takes the most recently filed figure when a period is restated', () => {
    const out = annualByPeriodEnd([
      fact({ end: '2023-12-31', val: 100, filed: '2024-02-01' }),
      fact({ end: '2023-12-31', val: 120, filed: '2025-02-01' }), // restatement
      fact({ end: '2023-12-31', val: 110, filed: '2024-08-01' }),
    ]);
    expect(out.get('2023-12-31')).toBe(120);
  });

  it('accepts foreign filers (20-F / 40-F)', () => {
    const out = annualByPeriodEnd([fact({ end: '2023-12-31', val: 500, form: '20-F' })]);
    expect(out.get('2023-12-31')).toBe(500);
  });

  it('skips malformed entries rather than poisoning the series', () => {
    const out = annualByPeriodEnd([
      fact({ end: '2023-12-31', val: NaN }),
      { end: '2022-12-31', val: 42 } as EdgarFact,            // no start -> not a duration
      fact({ start: '2021-01-01', end: '2021-12-31', val: 7 }),
    ]);
    expect(out.size).toBe(1);
    expect(out.get('2021-12-31')).toBe(7);
  });

  it('handles instant (non-duration) concepts when told to', () => {
    const out = annualByPeriodEnd(
      [{ end: '2023-12-31', val: 42, form: '10-K', filed: '2024-02-01' }],
      false,
    );
    expect(out.get('2023-12-31')).toBe(42);
  });
});

describe('valueForPeriod', () => {
  const byEnd = new Map([['2024-06-29', 100], ['2023-07-01', 90]]);

  it('matches an exact period end', () => {
    expect(valueForPeriod(byEnd, '2024-06-29')).toBe(100);
  });

  it('tolerates 52/53-week calendar drift between providers', () => {
    // Polygon may say 2024-06-30 where the filer's XBRL says 2024-06-29.
    expect(valueForPeriod(byEnd, '2024-06-30')).toBe(100);
    expect(valueForPeriod(byEnd, '2023-06-28')).toBe(90);
  });

  it('picks the closest period when two are within tolerance', () => {
    const close = new Map([['2024-01-01', 1], ['2024-01-05', 2]]);
    expect(valueForPeriod(close, '2024-01-04')).toBe(2);
  });

  it('returns null rather than reaching for a different fiscal year', () => {
    expect(valueForPeriod(byEnd, '2024-03-31')).toBeNull();
    expect(valueForPeriod(new Map(), '2024-06-29')).toBeNull();
  });
});
