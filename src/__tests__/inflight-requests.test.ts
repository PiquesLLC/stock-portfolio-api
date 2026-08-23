import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Request, Response, NextFunction } from 'express';
import {
  trackInFlightRequests,
  getInFlightRequests,
  getInFlightRequestCount,
  __resetInFlightRequestsForTests,
} from '../middleware/inflight';

// The in-flight request registry feeds the write-lock alert's suspect list. It
// runs on 100% of requests, so both halves matter: it must not leak across a
// multi-day uptime, and it must still be holding the interesting rows minutes
// later when the alert finally fires.

const fakeReq = (method: string, path: string): Request => ({ method, path } as unknown as Request);
const fakeRes = (): Response & EventEmitter => new EventEmitter() as unknown as Response & EventEmitter;

function track(method: string, path: string): Response & EventEmitter {
  const res = fakeRes();
  const next = vi.fn() as unknown as NextFunction;
  trackInFlightRequests(fakeReq(method, path), res, next);
  expect(next).toHaveBeenCalledOnce();
  return res;
}

describe('in-flight request registry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetInFlightRequestsForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports an open request, with its age', () => {
    track('POST', '/api/portfolio/abc/holdings');
    vi.advanceTimersByTime(5_000);

    const rows = getInFlightRequests();
    expect(rows).toHaveLength(1);
    expect(rows[0].request).toBe('POST /api/portfolio/abc/holdings');
    expect(rows[0].ageMs).toBe(5_000);
    expect(rows[0].responded).toBe(false);
  });

  it('drops a fast request entirely once it responds', () => {
    const res = track('GET', '/api/health');
    vi.advanceTimersByTime(50);
    res.emit('finish');

    expect(getInFlightRequests()).toHaveLength(0);
    expect(getInFlightRequestCount()).toBe(0);
  });

  // THE regression test. app.ts installs a global req.setTimeout(30000) that
  // answers 504 without destroying the socket, so 'finish' fires while the
  // handler — and whatever it is holding — keeps running. Deleting on 'finish'
  // evicted every such request ~2.5 minutes before the restart threshold, which
  // meant the suspect list read "none" during the exact incident it exists for.
  it('RETAINS a slow request after it responds, flagged as responded', () => {
    const res = track('POST', '/api/portfolio/abc/import');
    vi.advanceTimersByTime(30_000); // the global timeout fires and answers 504
    res.emit('finish');

    vi.advanceTimersByTime(4 * 60_000); // ...and four minutes later, the alert fires

    const rows = getInFlightRequests();
    expect(rows).toHaveLength(1);
    expect(rows[0].request).toBe('POST /api/portfolio/abc/import');
    expect(rows[0].responded).toBe(true);
    // Age is measured from when the request STARTED, not when it answered —
    // "this has been running 4.5 minutes" is the diagnostic signal.
    expect(rows[0].ageMs).toBe(270_000);
    // It is no longer counted as open, only as a suspect.
    expect(getInFlightRequestCount()).toBe(0);
  });

  it('records a retained request only once when close and finish both fire', () => {
    const res = track('POST', '/api/portfolio/abc/import');
    vi.advanceTimersByTime(15_000);
    res.emit('finish');
    res.emit('close');

    expect(getInFlightRequests()).toHaveLength(1);
  });

  it('removes an aborted request that never responded', () => {
    const res = track('GET', '/api/market/quote/AAPL');
    vi.advanceTimersByTime(100);
    res.emit('close'); // client hung up
    expect(getInFlightRequests()).toHaveLength(0);
  });

  it('forgets retained requests that are too old to say anything about a wedge now', () => {
    const res = track('POST', '/api/portfolio/abc/import');
    vi.advanceTimersByTime(20_000);
    res.emit('finish');
    expect(getInFlightRequests()).toHaveLength(1);

    vi.advanceTimersByTime(31 * 60_000);
    expect(getInFlightRequests()).toHaveLength(0);
  });

  it('bounds retained requests so a long uptime cannot grow the array without limit', () => {
    for (let i = 0; i < 120; i++) {
      const res = track('POST', `/api/portfolio/${i}/import`);
      vi.advanceTimersByTime(11_000);
      res.emit('finish');
    }
    // Capped at 50, and old entries also age out of the 30-minute window.
    expect(getInFlightRequests().length).toBeLessThanOrEqual(50);
  });

  // Eviction has to run in the SAME direction as consumption. The consumer sorts
  // by age descending and takes the top rows, so discarding the oldest would
  // throw away exactly what it asks for: during a wedge every DB-touching
  // request 504s at 30s, the cap recycles in under a minute at even light load,
  // and the onset requests — the ones running when writes stopped — would be the
  // first gone. A length-only assertion passes either direction, which is why
  // this one names the survivor.
  it('keeps the OLDEST suspects when it evicts, not the newest', () => {
    const first = track('POST', '/api/portfolio/onset/import');
    vi.advanceTimersByTime(11_000);
    first.emit('finish');

    // 80 more slow requests, all well inside the 30-minute window.
    for (let i = 0; i < 80; i++) {
      const res = track('POST', `/api/portfolio/${i}/import`);
      vi.advanceTimersByTime(11_000);
      res.emit('finish');
    }

    const rows = getInFlightRequests();
    expect(rows.length).toBeLessThanOrEqual(50);
    expect(rows[0].request).toBe('POST /api/portfolio/onset/import');
  });

  it('sorts the longest-running suspect first', () => {
    track('GET', '/api/slow');
    vi.advanceTimersByTime(10_000);
    track('GET', '/api/recent');

    const rows = getInFlightRequests();
    expect(rows[0].request).toBe('GET /api/slow');
    expect(rows[1].request).toBe('GET /api/recent');
  });

  it('truncates absurdly long paths rather than shipping them to Sentry whole', () => {
    track('GET', `/api/${'x'.repeat(500)}`);
    // 120-char cap on the path, plus "GET ".
    expect(getInFlightRequests()[0].request.length).toBeLessThanOrEqual(124);
  });
});
