import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { getSnapshotChartPoints } from '../services/snapshot.service';

// ---------------------------------------------------------------------------
// Real-execution unit test for getSnapshotChartPoints (snapshot.service.ts).
//
// The function depends ONLY on prisma.portfolioSnapshot.findMany, which the
// global setup mocks via __mockPrisma. We drive that mock and assert the real
// bucketing + outlier-removal logic — no app import, no supertest.
//
// Behavior under test (snapshot.service.ts ~:307-378):
//   - period <= 7d  -> hourly buckets (ISO key YYYY-MM-DDTHH), last write wins
//   - period  > 7d  -> daily  buckets (ISO key YYYY-MM-DD),   last write wins
//   - value = netEquity ?? totalValue, must be finite AND > 0
//   - < 2 raw snapshots                -> []
//   - < 2 surviving buckets            -> []
//   - daily outlier: a middle point that is >3x OR <0.33x BOTH neighbors is
//     dropped; first and last points are always kept.
// ---------------------------------------------------------------------------

const USER_ID = 'snap-user-1';

/** A snapshot row as selected by getSnapshotChartPoints. */
function snap(timestamp: number, value: number, netEquity?: number) {
  return {
    timestamp: new Date(timestamp),
    totalValue: value,
    netEquity: netEquity ?? value,
  };
}

function mockSnapshots(rows: ReturnType<typeof snap>[]) {
  (prismaMock as any).portfolioSnapshot.findMany.mockResolvedValue(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getSnapshotChartPoints', () => {
  describe('(A) hourly bucketing for short periods (<=7d)', () => {
    it('collapses 3 snapshots within the same hour to a single point', async () => {
      // Use a fixed UTC base so ISO hour buckets are unambiguous.
      // Hour A: 2026-03-10T15:** UTC  -> 3 snapshots, must dedupe to 1.
      // Hour B: 2026-03-10T17:** UTC  -> 1 snapshot (gives us a 2nd bucket so
      //                                   the result isn't emptied by the <2 guard).
      const hourA = Date.UTC(2026, 2, 10, 15, 0, 0);
      const hourB = Date.UTC(2026, 2, 10, 17, 0, 0);

      mockSnapshots([
        snap(hourA + 1 * 60_000, 50000),
        snap(hourA + 30 * 60_000, 50100),
        snap(hourA + 59 * 60_000, 50200), // last write for hour A → wins
        snap(hourB + 5 * 60_000, 50500),
      ]);

      const points = await getSnapshotChartPoints(USER_ID, 5); // <=7d → hourly

      // 4 raw snapshots → 2 hourly buckets → 2 clean points
      expect(points.length).toBe(2);
      // Hour-A bucket kept only the LAST snapshot in that hour (50200 @ :59)
      expect(points[0].value).toBe(50200);
      expect(points[0].time).toBe(hourA + 59 * 60_000);
      expect(points[1].value).toBe(50500);
      // Sorted ascending by time
      expect(points[0].time).toBeLessThan(points[1].time);
    });

    it('keeps snapshots in distinct hours as separate points', async () => {
      const base = Date.UTC(2026, 2, 10, 12, 0, 0);
      mockSnapshots([
        snap(base + 0 * 3_600_000, 50000),
        snap(base + 1 * 3_600_000, 50100),
        snap(base + 2 * 3_600_000, 50200),
      ]);

      const points = await getSnapshotChartPoints(USER_ID, 5);
      expect(points.length).toBe(3);
      expect(points.map(p => p.value)).toEqual([50000, 50100, 50200]);
    });
  });

  describe('(B) daily outlier removal for longer periods (>7d)', () => {
    it('drops a middle day that is ~5x both neighbors (length 4)', async () => {
      // 5 daily snapshots on 5 distinct days. Middle day (index 2) ~5x both
      // neighbors → outlier (>3x both) → removed. Length 5 → 4.
      const day = (n: number) => Date.UTC(2026, 2, 10 + n, 16, 0, 0); // distinct calendar days

      mockSnapshots([
        snap(day(0), 50000),
        snap(day(1), 51000),
        snap(day(2), 255000), // ~5x of ~51000 / ~52000 neighbors → glitch day
        snap(day(3), 52000),
        snap(day(4), 53000),
      ]);

      const points = await getSnapshotChartPoints(USER_ID, 30); // >7d → daily

      expect(points.length).toBe(4);
      // The spike day must be gone
      expect(points.some(p => p.value === 255000)).toBe(false);
      // Endpoints always preserved
      expect(points[0].value).toBe(50000);
      expect(points[points.length - 1].value).toBe(53000);
      expect(points.map(p => p.value)).toEqual([50000, 51000, 52000, 53000]);
    });

    it('does NOT drop a middle day that deviates from only one neighbor', async () => {
      // index 2 is high vs index 1 but close to index 3 → NOT both neighbors → kept.
      const day = (n: number) => Date.UTC(2026, 2, 10 + n, 16, 0, 0);
      mockSnapshots([
        snap(day(0), 50000),
        snap(day(1), 50000),
        snap(day(2), 250000),
        snap(day(3), 250000), // index 2's right neighbor is also high → not an outlier
        snap(day(4), 251000),
      ]);

      const points = await getSnapshotChartPoints(USER_ID, 30);
      expect(points.length).toBe(5);
      expect(points.some(p => p.value === 250000)).toBe(true);
    });

    it('keeps a low-dip outlier rule symmetric (<0.33x both neighbors removed)', async () => {
      const day = (n: number) => Date.UTC(2026, 2, 10 + n, 16, 0, 0);
      mockSnapshots([
        snap(day(0), 50000),
        snap(day(1), 51000),
        snap(day(2), 8000), // <0.33x of both neighbors → dip glitch → removed
        snap(day(3), 52000),
        snap(day(4), 53000),
      ]);

      const points = await getSnapshotChartPoints(USER_ID, 30);
      expect(points.length).toBe(4);
      expect(points.some(p => p.value === 8000)).toBe(false);
    });
  });

  describe('(C) insufficient data', () => {
    it('returns [] when fewer than 2 snapshots exist', async () => {
      mockSnapshots([snap(Date.UTC(2026, 2, 10, 16, 0, 0), 50000)]);
      const points = await getSnapshotChartPoints(USER_ID, 30);
      expect(points).toEqual([]);
    });

    it('returns [] when zero snapshots exist', async () => {
      mockSnapshots([]);
      const points = await getSnapshotChartPoints(USER_ID, 30);
      expect(points).toEqual([]);
    });

    it('returns [] when only one snapshot has a usable (>0, finite) value', async () => {
      // Two raw rows, but one has a non-positive value → filtered out by the
      // value>0 guard → only 1 usable point → [].
      const day = (n: number) => Date.UTC(2026, 2, 10 + n, 16, 0, 0);
      mockSnapshots([
        snap(day(0), 50000),
        snap(day(1), 0, 0), // netEquity 0 → filtered (value must be > 0)
      ]);
      const points = await getSnapshotChartPoints(USER_ID, 30);
      expect(points).toEqual([]);
    });
  });
});
