import type { Request, Response, NextFunction } from 'express';

// In-flight HTTP request registry.
//
// Companion to job-runner's getInFlightJobs, and it exists for the same reason:
// when the SQLite write lock wedges, the holder never announces itself. Every
// actor visible in the 2026-08-22 logs was a victim timing out on acquire.
// Background jobs are the obvious suspects, but several of this app's
// interactive transactions live in request handlers (portfolio mutations), so a
// jobs-only view can still come up empty and send the next investigation back to
// log archaeology.
//
// Tracking is one Map set/delete per request — cheap enough to leave on
// permanently, which is the point: a forensic that has to be switched on after
// the incident collects nothing during it.

interface InFlightRequest {
  method: string;
  path: string;
  startedAt: number;
}

const inFlight = new Map<number, InFlightRequest>();

// Responded-but-possibly-still-executing.
//
// app.ts installs a global `req.setTimeout(30000, ...)` that answers 504 WITHOUT
// destroying the socket, so 'finish' fires while the route handler keeps running
// — and keeps holding whatever it holds. Deleting on 'finish' would therefore
// evict every request that walked into a wedge about 2.5 minutes before the
// restart threshold, and the alert would report "none" in exactly the incident
// this was built for. So a slow request is retained after its response instead
// of dropped: a request that 504'd four minutes ago and never came back is the
// most interesting row on the alert, not the least.
const retained: Array<InFlightRequest & { respondedAt: number }> = [];

// Only slow requests are worth retaining — a fast one cannot have been holding
// the lock through an outage. This also bounds the array's growth by nature
// rather than by trimming a firehose.
const RETAIN_SLOWER_THAN_MS = 10_000;
const RETAIN_MAX = 50;
// Past this, a retained request says nothing about a wedge happening now.
const RETAIN_MAX_AGE_MS = 30 * 60 * 1000;

let nextId = 0;

// req.path only — never req.originalUrl. The path carries the ids that make an
// entry diagnosable ("POST /api/portfolio/<id>/holdings"); the query string it
// omits is where tokens and one-time codes ride, and this data is bound for a
// Sentry alert body.
const MAX_PATH_CHARS = 120;

export function trackInFlightRequests(req: Request, res: Response, next: NextFunction): void {
  const id = ++nextId;
  const entry: InFlightRequest = {
    method: req.method,
    path: req.path.slice(0, MAX_PATH_CHARS),
    startedAt: Date.now(),
  };
  inFlight.set(id, entry);

  // 'close' fires for a completed response AND an aborted connection, so an
  // entry cannot outlive its request and leak — which matters here because this
  // process runs for days at a time. 'finish' is belt-and-braces; the guard
  // below makes the double-fire idempotent.
  const release = (): void => {
    if (!inFlight.delete(id)) return;
    const respondedAt = Date.now();
    if (respondedAt - entry.startedAt < RETAIN_SLOWER_THAN_MS) return;

    // Prune by age at WRITE time, not only at read time: a row past the window
    // is invisible to readers but would still hold a cap slot, evicting a row
    // that is genuinely wanted.
    for (let i = retained.length - 1; i >= 0; i--) {
      if (respondedAt - retained[i].startedAt > RETAIN_MAX_AGE_MS) retained.splice(i, 1);
    }

    retained.push({ ...entry, respondedAt });

    // Evict the NEWEST, never the oldest. The consumer sorts by age descending
    // and takes the top rows, so dropping from the front would discard exactly
    // what it asks for: during a wedge every DB-touching request 504s at 30s, so
    // at a couple of requests per second the cap recycles in under a minute —
    // long before the alert at 3min — and the onset requests, the ones running
    // when writes stopped, would be the first gone. Eviction has to run in the
    // same direction as consumption.
    //
    // Accepted tradeoff: once full, newcomers are refused, so a buffer already
    // holding 50 slow requests from before an incident would shut its onset out.
    // Tolerable because the retain floor is 10s and the window is 30min — under
    // normal load this sits near-empty, since only imports and card renders run
    // that long — whereas a wedge makes EVERY writer slow, which is precisely
    // when eviction pressure is highest and the oldest rows matter most.
    if (retained.length > RETAIN_MAX) {
      let newest = 0;
      for (let i = 1; i < retained.length; i++) {
        if (retained[i].startedAt > retained[newest].startedAt) newest = i;
      }
      retained.splice(newest, 1);
    }
  };
  res.on('close', release);
  res.on('finish', release);
  next();
}

export interface InFlightRequestRow {
  request: string;
  ageMs: number;
  /** True when the response already went out but the handler may still be running. */
  responded: boolean;
}

/**
 * Requests worth suspecting, longest-running first: everything still open, plus
 * slow ones that have already answered but whose handler may not have returned.
 * A request still open after minutes while nothing can write is either the lock
 * holder or blocked behind it; either way it is the thing worth looking at.
 */
export function getInFlightRequests(nowMs: number = Date.now()): InFlightRequestRow[] {
  const open: InFlightRequestRow[] = Array.from(inFlight.values()).map(r => ({
    request: `${r.method} ${r.path}`,
    ageMs: nowMs - r.startedAt,
    responded: false,
  }));
  const answered: InFlightRequestRow[] = retained
    .filter(r => nowMs - r.startedAt <= RETAIN_MAX_AGE_MS)
    .map(r => ({
      request: `${r.method} ${r.path}`,
      ageMs: nowMs - r.startedAt,
      responded: true,
    }));
  return [...open, ...answered].sort((a, b) => b.ageMs - a.ageMs);
}

export function getInFlightRequestCount(): number {
  return inFlight.size;
}

/** Test seam — module state would otherwise leak across cases. */
export function __resetInFlightRequestsForTests(): void {
  inFlight.clear();
  retained.length = 0;
  nextId = 0;
}
