/**
 * Bottleneck Momentum — the weekly ranking behind Discover > Bottlenecks.
 *
 * WHY THIS EXISTS
 * The Bottlenecks catalog is editorial and near-static: a weekly cloud routine
 * revises the copy, but the ordering was fixed, so a returning user saw an
 * identical page every week and had no reason to come back. This service adds
 * the moving part — a weekly score that reshuffles entries and, more
 * importantly, lets the UI show WHAT MOVED since the user last looked.
 *
 * THE SCORE
 *   Pressure Score = 60% editorial anchor + 40% market momentum, scaled 0-100.
 *
 *   editorial  how binding the chokepoint's LAYER is judged to be, from its
 *              position in LAYER_ORDER (see getEditorialAnchor). Slow-moving,
 *              human-owned, and deliberately the larger weight so a quiet month
 *              cannot bury a structurally critical chokepoint.
 *   momentum   benchmark-relative price strength across the entry's tickers,
 *              clamped to -1..1. Supplies the week-to-week movement.
 *
 * ORDERING
 * Layer order stays editorial. Momentum only reorders entries WITHIN a layer.
 * The rank surfaced to users is SECTOR-wide, because layers hold 2-4 entries
 * and within-layer movement is almost always +/-1.
 *
 * FRAMING (compliance — read before writing any copy against this)
 * `momentum` is price movement, not merit. Everything built on it must read as
 * ACTIVITY ("moving this week"), never as a recommendation ("strongest",
 * "leaders", "top picks"). This is the same no-advice rule the weekly editorial
 * routine enforces on the catalog copy itself.
 *
 * WRITE BOUNDARY
 * Scores live in the BottleneckMomentum table, never in the catalog JSONs —
 * those files are owned by the editorial cloud routine, which commits them via
 * the GitHub Contents API. Writing to them from the app would collide with it.
 */

import prisma from '../utils/prisma';
import {
  getMultipleCandlesGradual,
  getBenchmarkTotalReturn,
  getBenchmarkCandles,
  ensureBenchmarksCached,
  type HistoricalCandles,
} from '../utils/candle-cache';
import {
  getCatalogEntries,
  getEditorialAnchor,
  type BottleneckEntry,
  type EntryMomentum,
} from './ai-bottlenecks.service';

const BENCHMARK = 'SPY';

/** ~4 and ~12 trading weeks. Short drives the weekly movement, long damps whipsaw. */
const SHORT_WINDOW_DAYS = 20;
const LONG_WINDOW_DAYS = 60;
const SHORT_WEIGHT = 0.65;
const LONG_WEIGHT = 0.35;

/** Relative return at which the momentum scale saturates (+/-25% vs SPY). */
const CLAMP_AT = 0.25;

/** The primary ticker represents the chokepoint; related names are corroboration. */
const PRIMARY_WEIGHT = 0.6;

const EDITORIAL_WEIGHT = 0.6;
const MOMENTUM_WEIGHT = 0.4;

/** Enough history for the 60-day window plus slack for holidays/halts. */
const CANDLE_DAYS = 90;

/**
 * Fraction of catalog entries that must score before a week is persisted.
 *
 * Below this the ranking is not measuring price, it is measuring which tickers
 * happened to be cached — and because the weekly guard keys off row existence,
 * persisting a thin week would lock that noise in until next Monday. Bailing
 * instead leaves the week unwritten so the next daily tick retries.
 */
const MIN_COVERAGE = 0.9;

/**
 * Safety valve on the fetch loop. getMultipleCandlesGradual deliberately fetches
 * only a couple of uncached tickers per call (its cap protects request-path
 * latency), so draining ~150 tickers takes many rounds. Budget one round per
 * ticker plus slack rather than hardcoding its cap, which would silently
 * under-fetch if that constant ever changed — it is not exported.
 */
const ROUND_SLACK = 12;

// ── Week keys ────────────────────────────────────────────────────────

/**
 * ISO-8601 week key, e.g. "2026-W34". Monday-based, and the YEAR comes from the
 * week's Thursday so the last days of December land in the right ISO year.
 *
 * The zero-padded form also sorts lexicographically, which is what lets the
 * prior-week lookup use a plain `{ lt: isoWeek }` string comparison.
 */
export function isoWeekOf(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7; // Mon=1 .. Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // shift to that week's Thursday
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// ── Math ─────────────────────────────────────────────────────────────

/**
 * Total return over the last `days` trading sessions, as a fraction.
 * Index-aligned with getBenchmarkTotalReturn, which is only equivalent to being
 * DATE-aligned when both series end on the same session — enforced by the
 * caller via lastSessionOf(), never assumed here.
 */
function totalReturn(closes: number[], days: number): number | null {
  if (closes.length < days + 1) return null;
  const start = closes[closes.length - 1 - days];
  const end = closes[closes.length - 1];
  if (!(start > 0)) return null;
  return (end - start) / start;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Last session in a candle series as YYYY-MM-DD, or '' if unusable. */
function lastSessionOf(series: { dates: (Date | string)[] } | null): string {
  if (!series || series.dates.length === 0) return '';
  const last = series.dates[series.dates.length - 1];
  if (last instanceof Date) return Number.isNaN(last.getTime()) ? '' : last.toISOString().slice(0, 10);
  const parsed = new Date(last);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

/**
 * One ticker's benchmark-relative strength, normalized to -1..1.
 * Returns null when there isn't enough history to measure even the short window.
 */
function tickerMomentum(
  candles: HistoricalCandles,
  benchShort: number | null,
  benchLong: number | null,
): number | null {
  const short = totalReturn(candles.closes, SHORT_WINDOW_DAYS);
  if (short == null || benchShort == null) return null;

  const long = totalReturn(candles.closes, LONG_WINDOW_DAYS);

  // Fall back to the short window alone rather than discarding the ticker. Note
  // this also triggers for a cache entry holding <61 closes, not only for
  // genuinely recent listings — so two tickers in one entry can be measured over
  // different spans. Acceptable (a 4-week read is still real signal) but it is
  // why entryMethod is reported alongside the score.
  const relative =
    long != null && benchLong != null
      ? SHORT_WEIGHT * (short - benchShort) + LONG_WEIGHT * (long - benchLong)
      : short - benchShort;

  return clamp(relative / CLAMP_AT, -1, 1);
}

/**
 * Blend an entry's tickers into one momentum reading. Primary carries
 * PRIMARY_WEIGHT; related names split the remainder. Weights renormalize over
 * whichever tickers actually resolved, so a missing related name doesn't drag
 * the entry toward zero.
 *
 * `benchSession` gates on date alignment: a ticker whose series ends on a
 * different session than the benchmark is measured over a different span, so it
 * is skipped rather than silently compared across mismatched windows. Pass ''
 * to disable the check (tests that construct synthetic series).
 */
export function blendEntryMomentum(
  entry: BottleneckEntry,
  candleMap: Map<string, HistoricalCandles>,
  benchShort: number | null,
  benchLong: number | null,
  benchSession = '',
): { momentum: number; used: string[]; missed: string[] } | null {
  const primary = entry.primaryTicker?.toUpperCase() || '';
  const related = (entry.relatedTickers || [])
    .map(t => t?.toUpperCase())
    .filter((t): t is string => !!t && t !== primary);

  const used: string[] = [];
  const missed: string[] = [];
  let weighted = 0;
  let weightSum = 0;

  const relatedShare = related.length > 0 ? (1 - PRIMARY_WEIGHT) / related.length : 0;

  for (const [ticker, weight] of [
    ...(primary ? [[primary, PRIMARY_WEIGHT] as const] : []),
    ...related.map(t => [t, relatedShare] as const),
  ]) {
    const candles = candleMap.get(ticker);
    const aligned = !benchSession || (candles != null && lastSessionOf(candles) === benchSession);
    const m = candles && aligned ? tickerMomentum(candles, benchShort, benchLong) : null;
    if (m == null) {
      missed.push(ticker);
      continue;
    }
    used.push(ticker);
    weighted += m * weight;
    weightSum += weight;
  }

  if (weightSum === 0) return null;
  return { momentum: weighted / weightSum, used, missed };
}

/** Blend the editorial anchor and momentum into the 0-100 Pressure Score. */
export function pressureScore(editorial: number, momentum: number): number {
  const momentum01 = (momentum + 1) / 2; // -1..1 -> 0..1
  return Math.round(100 * (EDITORIAL_WEIGHT * editorial + MOMENTUM_WEIGHT * momentum01) * 10) / 10;
}

/**
 * Rank deltas measured over only the entries present in BOTH weeks.
 *
 * The catalog is regenerated weekly by an external editorial routine that can
 * add or remove entries. Diffing raw sector ranks would report every surviving
 * entry as having "moved" when two new entries are inserted above them — the
 * movers strip would fill with entries that did not move at all. Ranking both
 * weeks over the shared set makes the delta immune to population change.
 *
 * @param currentOrder entry ids, already sorted best-to-worst for this week
 * @param prevRanks    entry id -> rank in the prior scored week
 */
export function sharedRankDeltas(
  currentOrder: string[],
  prevRanks: Map<string, number>,
): Map<string, number> {
  const shared = currentOrder.filter(id => prevRanks.has(id));

  const currShared = new Map<string, number>();
  shared.forEach((id, i) => currShared.set(id, i + 1));

  const prevShared = new Map<string, number>();
  [...shared]
    .sort((a, b) => prevRanks.get(a)! - prevRanks.get(b)!)
    .forEach((id, i) => prevShared.set(id, i + 1));

  const deltas = new Map<string, number>();
  for (const id of shared) deltas.set(id, prevShared.get(id)! - currShared.get(id)!);
  return deltas;
}

// ── The weekly job ───────────────────────────────────────────────────

interface ScoredEntry {
  entry: BottleneckEntry;
  momentum: number;
  editorial: number;
  score: number;
  used: string[];
  missed: string[];
}

export interface MomentumRefreshResult {
  isoWeek: string;
  scored: number;
  skipped: number;
  reason?: string;
}

/**
 * Recompute momentum for every catalog entry and persist one row per entry for
 * the current ISO week.
 *
 * Self-healing by design: scheduled daily but no-ops once the current week is
 * already scored, so a deploy landing in the scheduled window costs a day
 * rather than a whole week. Pass `force` to rescore the current week.
 */
export async function refreshBottleneckMomentum(force = false): Promise<MomentumRefreshResult> {
  const isoWeek = isoWeekOf(new Date());

  if (!force) {
    // Safe as a completion check ONLY because the write below is a single
    // transaction — rows for a week exist all-or-nothing. If that write is ever
    // split back into per-row upserts, a partial failure would latch this
    // no-op for the rest of the week and the daily retry would never recover.
    const existing = await prisma.bottleneckMomentum.count({ where: { isoWeek } });
    if (existing > 0) {
      return { isoWeek, scored: 0, skipped: existing, reason: 'already scored this week' };
    }
  }

  const entries = getCatalogEntries();
  if (entries.length === 0) {
    return { isoWeek, scored: 0, skipped: 0, reason: 'empty catalog' };
  }

  // Benchmark first — without it there is no relative strength to compute.
  await ensureBenchmarksCached();
  const benchShort = getBenchmarkTotalReturn(BENCHMARK, SHORT_WINDOW_DAYS);
  const benchLong = getBenchmarkTotalReturn(BENCHMARK, LONG_WINDOW_DAYS);
  const benchSession = lastSessionOf(getBenchmarkCandles(BENCHMARK));
  if (benchShort == null || !benchSession) {
    return { isoWeek, scored: 0, skipped: 0, reason: `${BENCHMARK} benchmark unavailable` };
  }

  // Every ticker the catalog references, deduped.
  const tickers = new Set<string>();
  for (const e of entries) {
    if (e.primaryTicker) tickers.add(e.primaryTicker.toUpperCase());
    for (const t of e.relatedTickers || []) if (t) tickers.add(t.toUpperCase());
  }

  // Drain the gradual fetcher. It returns everything currently cached plus a
  // couple of freshly-fetched tickers per call, so repeated calls converge.
  const wanted = [...tickers];
  const maxRounds = wanted.length + ROUND_SLACK;
  let candleMap = new Map<string, HistoricalCandles>();
  let lastSettled = -1;
  for (let round = 0; round < maxRounds; round++) {
    const result = await getMultipleCandlesGradual(wanted, CANDLE_DAYS);
    candleMap = result.data;
    if (result.tickersPending.length === 0) break;
    // Progress means "settled", not "succeeded" — counting only successes would
    // break the loop early on a round where both fetched tickers failed, while
    // tickers were still pending.
    const settled = result.tickersWithData.length + result.tickersFailed.length;
    if (settled <= lastSettled) break; // genuinely stuck
    lastSettled = settled;
  }

  // Score every entry we can.
  const scored: ScoredEntry[] = [];
  for (const entry of entries) {
    const blended = blendEntryMomentum(entry, candleMap, benchShort, benchLong, benchSession);
    if (!blended) continue;
    const editorial = getEditorialAnchor(entry.sector, entry.layer);
    scored.push({
      entry,
      momentum: blended.momentum,
      editorial,
      score: pressureScore(editorial, blended.momentum),
      used: blended.used,
      missed: blended.missed,
    });
  }

  // Coverage gate. A thin week is worse than no week: it would rank entries by
  // cache warmth rather than price, and the weekly guard would hold that until
  // next Monday. Bail without writing so tomorrow's tick retries.
  const coverage = scored.length / entries.length;
  if (coverage < MIN_COVERAGE) {
    const reason = `insufficient coverage: ${scored.length}/${entries.length} entries scored (need ${Math.ceil(MIN_COVERAGE * entries.length)})`;
    console.warn(`[BottleneckMomentum] ${isoWeek}: ${reason} — not persisting, will retry next tick`);
    return { isoWeek, scored: 0, skipped: entries.length - scored.length, reason };
  }

  // Diff against the most recent PRIOR week that actually has rows — not "last
  // week" literally — so a skipped week still yields a meaningful delta.
  const prior = await prisma.bottleneckMomentum.findFirst({
    where: { isoWeek: { lt: isoWeek } },
    orderBy: { isoWeek: 'desc' },
    select: { isoWeek: true },
  });
  const prevRanks = new Map<string, number>();
  if (prior) {
    const rows = await prisma.bottleneckMomentum.findMany({
      where: { isoWeek: prior.isoWeek },
      select: { entryId: true, rank: true },
    });
    for (const r of rows) prevRanks.set(r.entryId, r.rank);
  }

  const bySector = new Map<string, ScoredEntry[]>();
  for (const s of scored) {
    const list = bySector.get(s.entry.sector) || [];
    list.push(s);
    bySector.set(s.entry.sector, list);
  }

  const rows: {
    entryId: string; isoWeek: string; sector: string; layer: string;
    momentum: number; editorial: number; score: number;
    rank: number; prevRank: number | null; rankDelta: number | null;
    prevIsoWeek: string | null; tickersUsed: string; tickersMissed: string;
    computedAt: Date;
  }[] = [];

  for (const [sector, list] of bySector) {
    list.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.entry.name.localeCompare(b.entry.name)));

    const deltas = sharedRankDeltas(list.map(s => s.entry.id), prevRanks);

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const prevRank = prevRanks.get(s.entry.id) ?? null;
      rows.push({
        entryId: s.entry.id,
        isoWeek,
        sector,
        layer: s.entry.layer,
        momentum: s.momentum,
        editorial: s.editorial,
        score: s.score,
        rank: i + 1,
        prevRank,
        rankDelta: deltas.get(s.entry.id) ?? null,
        prevIsoWeek: prevRank == null ? null : prior?.isoWeek ?? null,
        tickersUsed: JSON.stringify(s.used),
        tickersMissed: JSON.stringify(s.missed),
        computedAt: new Date(),
      });
    }
  }

  // Single transaction: the week lands whole or not at all. Per-row upserts
  // would take the SQLite write lock 85+ times in a row during the maintenance
  // window (the 2026-07-14 outage shape) and, worse, a mid-write failure would
  // leave rows behind that make the weekly guard treat the week as done.
  await prisma.$transaction(async tx => {
    await tx.bottleneckMomentum.deleteMany({ where: { isoWeek } });
    await tx.bottleneckMomentum.createMany({ data: rows });
  });

  const unscored = entries.length - scored.length;
  console.log(
    `[BottleneckMomentum] ${isoWeek}: scored ${rows.length}/${entries.length} entries` +
      (unscored > 0 ? ` (${unscored} lacked usable price history)` : '') +
      (prior ? ` — deltas vs ${prior.isoWeek}` : ' — no prior week, deltas null'),
  );

  return { isoWeek, scored: rows.length, skipped: unscored };
}

// ── Read path ────────────────────────────────────────────────────────

/**
 * Momentum for the most recent scored week, keyed by entry id.
 * Returns an empty map on any failure — the catalog must still render if the
 * job has never run, the table is empty, or the DB is unavailable.
 */
export async function getLatestMomentum(): Promise<Map<string, EntryMomentum>> {
  const out = new Map<string, EntryMomentum>();
  try {
    const latest = await prisma.bottleneckMomentum.findFirst({
      orderBy: { isoWeek: 'desc' },
      select: { isoWeek: true },
    });
    if (!latest) return out;

    const rows = await prisma.bottleneckMomentum.findMany({
      where: { isoWeek: latest.isoWeek },
      select: {
        entryId: true, score: true, momentum: true, rank: true,
        rankDelta: true, isoWeek: true, prevIsoWeek: true, tickersUsed: true,
      },
    });
    for (const r of rows) {
      let tickersUsed: string[] = [];
      try {
        const parsed = JSON.parse(r.tickersUsed);
        if (Array.isArray(parsed)) tickersUsed = parsed.filter((t): t is string => typeof t === 'string');
      } catch {
        // Malformed JSON must not sink the whole response; the UI falls back to
        // omitting the ticker list from its explanation.
      }
      out.set(r.entryId, {
        score: r.score,
        momentum: r.momentum,
        rank: r.rank,
        rankDelta: r.rankDelta,
        isoWeek: r.isoWeek,
        prevIsoWeek: r.prevIsoWeek,
        tickersUsed,
      });
    }
  } catch (err) {
    console.warn(
      '[BottleneckMomentum] Read failed, serving unranked catalog:',
      err instanceof Error ? err.message : err,
    );
  }
  return out;
}

/** Drop scored weeks older than `keepWeeks` distinct weeks. */
export async function pruneBottleneckMomentum(keepWeeks = 12): Promise<number> {
  const weeks = await prisma.bottleneckMomentum.findMany({
    distinct: ['isoWeek'],
    orderBy: { isoWeek: 'desc' },
    select: { isoWeek: true },
  });
  if (weeks.length <= keepWeeks) return 0;
  const cutoff = weeks[keepWeeks].isoWeek;
  const { count } = await prisma.bottleneckMomentum.deleteMany({
    where: { isoWeek: { lte: cutoff } },
  });
  if (count > 0) console.log(`[BottleneckMomentum] Pruned ${count} rows at or before ${cutoff}`);
  return count;
}
