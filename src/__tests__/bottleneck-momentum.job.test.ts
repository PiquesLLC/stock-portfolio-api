import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import type { HistoricalCandles } from '../utils/candle-cache';
import type { BottleneckEntry } from '../services/ai-bottlenecks.service';

/**
 * Integration tests for refreshBottleneckMomentum — the job, not the maths.
 *
 * This function was completely untested in the first cut, and all three of the
 * worst defects blind review found lived inside it: the fetch loop that could
 * only ever resolve a fraction of the catalog, the non-atomic write that let a
 * partial failure latch the weekly no-op, and the rank deltas that measured
 * catalog churn. Every one of those is asserted here.
 */

// ── the catalog under test ───────────────────────────────────────────

const SESSION = '2026-03-03';

function entry(id: string, layer: string, primary: string, related: string[] = []): BottleneckEntry {
  return {
    id, name: id.toUpperCase(), sector: 'AI', layer,
    primaryTicker: primary, relatedTickers: related,
    thesisShort: '', thesisLong: '', chokepointMetrics: [],
    catalysts: [], risks: [], featured: false, lastUpdated: '2026-01-01',
  };
}

// 15 entries / 30 unique tickers. Sized so that a fetcher handing back 2 per
// call needs 15 rounds — more than the 12-round budget the original code used.
const ENTRIES: BottleneckEntry[] = Array.from({ length: 15 }, (_, i) =>
  entry(`e${i}`, i < 8 ? 'Compute' : 'Memory', `T${i}A`, [`T${i}B`]),
);

let catalog: BottleneckEntry[] = ENTRIES;

vi.mock('../services/ai-bottlenecks.service', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/ai-bottlenecks.service')>();
  return { ...actual, getCatalogEntries: () => catalog };
});

// ── a candle cache that drips like the real one ──────────────────────

const FETCH_PER_CALL = 2; // mirrors MAX_TICKERS_PER_REQUEST in candle-cache

let resolved: Set<string>;
let permanentlyFailing: Set<string>;
let gradualCalls: number;

function candles(ticker: string, ret: number, endSession = SESSION): HistoricalCandles {
  const closes = new Array(62).fill(100);
  closes[closes.length - 1] = 100 * (1 + ret);
  const end = new Date(`${endSession}T00:00:00Z`).getTime();
  return {
    ticker, closes,
    dates: closes.map((_, i) => new Date(end - (closes.length - 1 - i) * 86400000)),
    returns: [], fetchedAt: Date.now(), partial: false, daysAvailable: closes.length,
  };
}

vi.mock('../utils/candle-cache', () => ({
  ensureBenchmarksCached: vi.fn().mockResolvedValue(undefined),
  getBenchmarkTotalReturn: vi.fn(() => 0),
  getBenchmarkCandles: vi.fn(() => ({
    ticker: 'SPY', closes: [], returns: [], fetchedAt: Date.now(),
    dates: [`${SESSION}T00:00:00Z`],
  })),
  getMultipleCandlesGradual: vi.fn(async (tickers: string[]) => {
    gradualCalls++;
    const outstanding = tickers.filter(t => !resolved.has(t) && !permanentlyFailing.has(t));
    for (const t of outstanding.slice(0, FETCH_PER_CALL)) resolved.add(t);
    const data = new Map<string, HistoricalCandles>();
    for (const t of tickers) if (resolved.has(t)) data.set(t, candles(t, 0.1));
    const pending = tickers.filter(t => !resolved.has(t) && !permanentlyFailing.has(t));
    return {
      data,
      tickersWithData: [...resolved].filter(t => tickers.includes(t)),
      tickersPending: pending,
      tickersFailed: [...permanentlyFailing].filter(t => tickers.includes(t)),
      allCached: pending.length === 0,
      progress: 0,
      message: '',
    };
  }),
}));

const { refreshBottleneckMomentum } = await import('../services/bottleneck-momentum.service');

const bm = () => prismaMock.bottleneckMomentum as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  catalog = ENTRIES;
  resolved = new Set();
  permanentlyFailing = new Set();
  gradualCalls = 0;
  vi.clearAllMocks();
  bm().count.mockResolvedValue(0);
  bm().findFirst.mockResolvedValue(null);
  bm().findMany.mockResolvedValue([]);
  bm().createMany.mockResolvedValue({ count: 0 });
  bm().deleteMany.mockResolvedValue({ count: 0 });
  (prismaMock.$transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation((arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prismaMock) : Promise.all(arg as unknown[]),
  );
});

/** The rows handed to createMany in the write transaction. */
function writtenRows(): Record<string, unknown>[] {
  expect(bm().createMany).toHaveBeenCalledTimes(1);
  return bm().createMany.mock.calls[0][0].data as Record<string, unknown>[];
}

// ── the critical defect ──────────────────────────────────────────────

describe('fetch loop coverage', () => {
  it('drains the fetcher until every ticker resolves, however many rounds that takes', async () => {
    // THE CRITICAL REGRESSION. The original budgeted 12 rounds against a
    // fetcher that hands back 2 tickers per call; with 30 tickers it would
    // resolve 24, score a subset, and persist a ranking driven by cache
    // warmth rather than price — silently, and latched for the whole week.
    const result = await refreshBottleneckMomentum();

    expect(resolved.size).toBe(30);
    expect(gradualCalls).toBeGreaterThanOrEqual(15);
    expect(result.scored).toBe(15);
    expect(writtenRows()).toHaveLength(15);
  });

  it('does not break early on a round where every fetch fails', async () => {
    // Progress must be counted as "settled", not "succeeded". Counting only
    // successes stalls the loop the first time a round resolves nothing, while
    // tickers are still pending.
    permanentlyFailing = new Set(['T0A', 'T0B']);
    const result = await refreshBottleneckMomentum();

    expect(resolved.size).toBe(28); // everything except the two dead tickers
    expect(result.scored).toBe(14); // e0 unscorable, the other 14 fine
    expect(writtenRows().map(r => r.entryId)).not.toContain('e0');
  });
});

// ── the coverage gate ────────────────────────────────────────────────

describe('coverage gate', () => {
  it('refuses to persist a week scored on too little of the catalog', async () => {
    // 8 of 15 entries unscorable → 47% coverage, well under the 90% floor.
    // Persisting would lock cache-warmth ordering in until next Monday,
    // because the weekly guard keys off row existence.
    permanentlyFailing = new Set(ENTRIES.slice(0, 8).flatMap(e => [e.primaryTicker, ...e.relatedTickers]));

    const result = await refreshBottleneckMomentum();

    expect(result.scored).toBe(0);
    expect(result.reason).toMatch(/insufficient coverage/);
    expect(bm().createMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('persists when coverage clears the floor', async () => {
    // 1 of 15 unscorable → 93%.
    permanentlyFailing = new Set(['T0A', 'T0B']);
    const result = await refreshBottleneckMomentum();
    expect(result.scored).toBe(14);
    expect(bm().createMany).toHaveBeenCalledTimes(1);
  });

  it('bails without writing when the benchmark is unavailable', async () => {
    const cache = await import('../utils/candle-cache');
    vi.mocked(cache.getBenchmarkTotalReturn).mockReturnValueOnce(null);

    const result = await refreshBottleneckMomentum();
    expect(result.reason).toMatch(/benchmark unavailable/);
    expect(bm().createMany).not.toHaveBeenCalled();
  });
});

// ── atomicity ────────────────────────────────────────────────────────

describe('the weekly write is atomic', () => {
  it('writes the whole week in ONE transaction, never row-by-row', async () => {
    // Per-row upserts took the SQLite write lock 85+ times inside the
    // maintenance window AND, worse, left rows behind on a mid-write failure —
    // which the weekly guard reads as "already scored", so the retry and every
    // later daily tick no-op and the week stays half-written.
    await refreshBottleneckMomentum();

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(bm().deleteMany).toHaveBeenCalledWith({ where: { isoWeek: expect.any(String) } });
    expect(bm().createMany).toHaveBeenCalledTimes(1);
    expect(bm().upsert).not.toHaveBeenCalled();
  });

  it('propagates a transaction failure instead of reporting success', async () => {
    (prismaMock.$transaction as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db locked'));
    await expect(refreshBottleneckMomentum()).rejects.toThrow('db locked');
  });
});

// ── the weekly guard ─────────────────────────────────────────────────

describe('once-per-week gating', () => {
  it('no-ops when the current week already has rows', async () => {
    bm().count.mockResolvedValue(15);
    const result = await refreshBottleneckMomentum();

    expect(result.reason).toBe('already scored this week');
    expect(result.scored).toBe(0);
    expect(bm().createMany).not.toHaveBeenCalled();
    expect(gradualCalls).toBe(0); // must not even touch the market data
  });

  it('rescores the current week when forced', async () => {
    bm().count.mockResolvedValue(15);
    const result = await refreshBottleneckMomentum(true);

    expect(result.scored).toBe(15);
    expect(bm().count).not.toHaveBeenCalled();
  });
});

// ── ranking + deltas ─────────────────────────────────────────────────

describe('ranking and deltas', () => {
  it('ranks sector-wide by score descending, starting at 1', async () => {
    await refreshBottleneckMomentum();
    const rows = writtenRows();
    const ranks = rows.map(r => r.rank as number).sort((a, b) => a - b);
    expect(ranks).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));

    const byRank = [...rows].sort((a, b) => (a.rank as number) - (b.rank as number));
    for (let i = 1; i < byRank.length; i++) {
      expect(byRank[i].score as number).toBeLessThanOrEqual(byRank[i - 1].score as number);
    }
  });

  it('leaves deltas null on the first scored week', async () => {
    await refreshBottleneckMomentum();
    expect(writtenRows().every(r => r.rankDelta === null && r.prevIsoWeek === null)).toBe(true);
  });

  it('diffs against the most recent SCORED week, not the literal prior week', async () => {
    // A skipped week must not null out every delta.
    bm().findFirst.mockResolvedValue({ isoWeek: '2026-W30' });
    bm().findMany.mockResolvedValue(ENTRIES.map((e, i) => ({ entryId: e.id, rank: i + 1 })));

    await refreshBottleneckMomentum();
    const rows = writtenRows();
    expect(rows.every(r => r.prevIsoWeek === '2026-W30')).toBe(true);
    expect(rows.some(r => r.rankDelta !== null)).toBe(true);
  });

  it('reports NO movement when the catalog grew but relative order held', async () => {
    // THE CHURN REGRESSION. Entries added by the editorial routine must not
    // make every surviving entry read as having moved — raw sector-rank diffing
    // would report all ten of them as down-5 and fill the movers strip with
    // entries whose price did nothing.
    //
    // Simulated as two real weeks rather than a hand-written prior ranking:
    // within-layer order is by NAME, so "E10" sorts before "E8" and any
    // hand-assigned sequence would be asserting the wrong baseline.
    const prior = ENTRIES.slice(5);

    // Week 1 — the smaller catalog. Capture the ranks the job actually assigns.
    catalog = prior;
    await refreshBottleneckMomentum();
    const week1 = writtenRows().map(r => ({ entryId: r.entryId as string, rank: r.rank as number }));
    expect(week1).toHaveLength(10);

    // Week 2 — five entries added above them, no price change anywhere.
    vi.clearAllMocks();
    catalog = ENTRIES;
    resolved = new Set();
    bm().count.mockResolvedValue(0);
    bm().findFirst.mockResolvedValue({ isoWeek: '2026-W33' });
    bm().findMany.mockResolvedValue(week1);
    bm().createMany.mockResolvedValue({ count: 0 });
    bm().deleteMany.mockResolvedValue({ count: 0 });

    await refreshBottleneckMomentum();
    const rows = writtenRows();

    for (const e of prior) {
      expect(rows.find(r => r.entryId === e.id)!.rankDelta, `${e.id} should not have moved`).toBe(0);
    }
    // The five new entries have no prior rank at all.
    for (const e of ENTRIES.slice(0, 5)) {
      expect(rows.find(r => r.entryId === e.id)!.rankDelta).toBeNull();
    }
  });

  it('records which tickers actually contributed', async () => {
    permanentlyFailing = new Set(['T0B']); // e0's related ticker only
    await refreshBottleneckMomentum();
    const row = writtenRows().find(r => r.entryId === 'e0')!;
    expect(JSON.parse(row.tickersUsed as string)).toEqual(['T0A']);
    expect(JSON.parse(row.tickersMissed as string)).toEqual(['T0B']);
  });
});

// ── empty catalog ────────────────────────────────────────────────────

describe('degenerate input', () => {
  it('bails cleanly on an empty catalog', async () => {
    catalog = [];
    const result = await refreshBottleneckMomentum();
    expect(result.reason).toBe('empty catalog');
    expect(bm().createMany).not.toHaveBeenCalled();
  });
});
