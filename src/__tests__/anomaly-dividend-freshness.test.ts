import { describe, it, expect } from 'vitest';
import { isDividendChangeFresh, pickDividendCompareEvent } from '../services/anomaly-detection.service';

/**
 * Freshness gate for dividend-change alerts. The bug this fixes: a real dividend
 * raise (e.g. AAPL $0.26 -> $0.27, ex-date ~May 11) surfaced as a fresh "1m ago"
 * notification on June 17 — ~5 weeks stale — because the old gate allowed any
 * change within 60 days. The new gate only passes genuinely recent news.
 */
describe('isDividendChangeFresh', () => {
  const now = new Date('2026-06-19T12:00:00Z');

  it('passes a freshly-DECLARED dividend with a future ex-date (the 24h-of-announcement path)', () => {
    const future = new Date('2026-06-25T00:00:00Z'); // declared, ex-date 6 days out
    expect(isDividendChangeFresh(future, now)).toBe(true);
  });

  it('passes a dividend that just went ex within the window', () => {
    const recent = new Date('2026-06-12T00:00:00Z'); // 7 days ago
    expect(isDividendChangeFresh(recent, now)).toBe(true);
  });

  it('REJECTS the stale AAPL case — ex-date ~5 weeks ago must not alert as fresh', () => {
    const staleAapl = new Date('2026-05-11T00:00:00Z'); // ~39 days ago
    expect(isDividendChangeFresh(staleAapl, now)).toBe(false);
  });

  it('rejects a change just past the 10-day window', () => {
    const justOld = new Date('2026-06-08T00:00:00Z'); // 11 days ago
    expect(isDividendChangeFresh(justOld, now)).toBe(false);
  });

  it('treats the exact 10-day boundary as still fresh', () => {
    const boundary = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    expect(isDividendChangeFresh(boundary, now)).toBe(true);
  });

  it('defaults the comparison time to now when omitted', () => {
    const farFuture = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const farPast = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    expect(isDividendChangeFresh(farFuture)).toBe(true);
    expect(isDividendChangeFresh(farPast)).toBe(false);
  });
});

describe('pickDividendCompareEvent', () => {
  const mk = (exDate: string, amt: number) => ({ exDate: new Date(exDate), amountPerShare: amt });
  const now = new Date('2026-06-19T12:00:00Z');

  it('compares a freshly-DECLARED dividend (future ex) to the immediately previous payout', () => {
    // events[0] = declared future $0.27; events[1] = last paid $0.26; a year-ago $0.27 must NOT be chosen
    const events = [
      mk('2026-08-11', 0.27), // declared, future ex-date
      mk('2026-05-11', 0.26), // previous payout
      mk('2026-02-11', 0.26),
      mk('2025-08-11', 0.27), // ~year-ago same-quarter, equal to the new amount
    ];
    const compare = pickDividendCompareEvent(events[0], events, now);
    expect(compare).toBe(events[1]);            // previous payout, not the YoY $0.27
    expect(compare?.amountPerShare).toBe(0.26); // so the raise is DETECTED, not skipped
  });

  it('prefers the YoY same-quarter dividend for an already-ex change', () => {
    const events = [
      mk('2026-05-11', 0.27), // most recent, already ex
      mk('2026-02-11', 0.26),
      mk('2025-11-11', 0.26),
      mk('2025-05-11', 0.26), // ~12 months back
    ];
    const compare = pickDividendCompareEvent(events[0], events, now);
    expect(compare).toBe(events[3]); // the ~year-ago dividend
  });

  it('falls back to the previous payout when no YoY match exists', () => {
    const events = [
      mk('2026-05-11', 0.27),
      mk('2026-02-11', 0.26), // only ~3 months back — no 9–15mo match
    ];
    const compare = pickDividendCompareEvent(events[0], events, now);
    expect(compare).toBe(events[1]);
  });
});
