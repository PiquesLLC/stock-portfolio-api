import { describe, expect, it } from 'vitest';
import { computePriorThresholds, etWeekMonday, ChartBars } from '../utils/milestone-ranges';

// Unix seconds for an ISO instant
const ts = (iso: string): number => Date.parse(iso) / 1000;

// Thursday 2026-07-16, 2:00 PM ET — mid regular session
const NOW = new Date('2026-07-16T14:00:00-04:00');

// Daily bars (9:30 ET open timestamps). Today's bar carries the session's
// extremes and must be excluded from every threshold.
const DAILY: ChartBars = {
  timestamps: [
    ts('2025-09-10T13:30:00Z'), // last September (within 1y window)
    ts('2026-07-13T13:30:00Z'), // Mon this week
    ts('2026-07-14T13:30:00Z'), // Tue this week
    ts('2026-07-15T13:30:00Z'), // Wed this week
    ts('2026-07-16T13:30:00Z'), // TODAY
  ],
  highs: [320, 330.5, 330.0, 331.9, 334.0],
  lows: [210, 322, 321, 325, 300.0],
};

// Weekly bars (Monday timestamps). The current week's bar already contains
// today's session, so it must be excluded from all-time thresholds — the
// daily bars above bridge Mon..Wed of this week back in.
const WEEKLY: ChartBars = {
  timestamps: [
    ts('2000-01-03T14:30:00Z'), // dot-com era week
    ts('2026-07-06T13:30:00Z'), // last week
    ts('2026-07-13T13:30:00Z'), // CURRENT week (includes today)
  ],
  highs: [260, 329, 334.0],
  lows: [30, 318, 300.0],
};

describe('etWeekMonday', () => {
  it('maps mid-week days to that week\'s Monday', () => {
    expect(etWeekMonday(new Date('2026-07-16T14:00:00-04:00'))).toBe('2026-07-13'); // Thu
    expect(etWeekMonday(new Date('2026-07-13T10:00:00-04:00'))).toBe('2026-07-13'); // Mon itself
  });

  it('maps Sunday to the PREVIOUS Monday (week runs Mon-Sun)', () => {
    expect(etWeekMonday(new Date('2026-07-19T12:00:00-04:00'))).toBe('2026-07-13');
  });

  it('crosses month and year boundaries', () => {
    expect(etWeekMonday(new Date('2026-04-01T12:00:00-04:00'))).toBe('2026-03-30');
    expect(etWeekMonday(new Date('2026-01-01T12:00:00-05:00'))).toBe('2025-12-29');
  });

  it('uses the ET calendar day even after UTC has rolled over', () => {
    // 11:30 PM ET Thursday = 3:30 AM UTC Friday — still Thursday's week in ET
    expect(etWeekMonday(new Date('2026-07-16T23:30:00-04:00'))).toBe('2026-07-13');
  });

  it('is stable across the DST spring-forward week', () => {
    // DST began Sun 2026-03-08; Wed of that week still maps to Mon 03-09
    expect(etWeekMonday(new Date('2026-03-11T12:00:00-04:00'))).toBe('2026-03-09');
  });
});

describe('computePriorThresholds', () => {
  it('excludes today\'s bar from the 52-week thresholds', () => {
    const t = computePriorThresholds(DAILY, WEEKLY, NOW);
    // Today printed 334 high / 300 low — neither may leak into the record
    expect(t.week52High).toBe(331.9);
    expect(t.week52Low).toBe(210);
  });

  it('excludes the current week\'s weekly bar but bridges this week\'s prior days into the all-time record', () => {
    const t = computePriorThresholds(DAILY, WEEKLY, NOW);
    // Wed's 331.9 (daily bridge) beats every completed week's high (329);
    // the current week's 334 weekly high must NOT be used
    expect(t.allTimeHigh).toBe(331.9);
    expect(t.allTimeLow).toBe(30);
  });

  it('still excludes today late in the ET evening after UTC rolled over', () => {
    const lateNow = new Date('2026-07-16T23:30:00-04:00'); // 03:30Z on the 17th
    const t = computePriorThresholds(DAILY, WEEKLY, lateNow);
    expect(t.week52High).toBe(331.9);
    expect(t.allTimeHigh).toBe(331.9);
  });

  it('still excludes a current-week weekly bar stamped Sunday-evening ET (Monday-00:00 UTC style)', () => {
    const weekly: ChartBars = {
      timestamps: [
        ts('2026-07-05T23:30:00Z'), // completed week, ALSO Sunday-stamped — must stay counted
        ts('2026-07-12T23:30:00Z'), // current week stamped Sun 7:30 PM ET — must be excluded
      ],
      highs: [329, 334.0],
      lows: [318, 300.0],
    };
    const t = computePriorThresholds(DAILY, weekly, NOW);
    // Current week's 334 high / 300 low may not leak in; last week's Sunday-
    // stamped bar still counts (329/318), and the Mon-Wed daily bridge tops
    // the high at 331.9
    expect(t.allTimeHigh).toBe(331.9);
    expect(t.allTimeLow).toBe(318);
  });

  it('returns null all-time values unless BOTH sources are available', () => {
    const dailyOnly = computePriorThresholds(DAILY, null, NOW);
    expect(dailyOnly.week52High).toBe(331.9);
    expect(dailyOnly.allTimeHigh).toBeNull();
    expect(dailyOnly.allTimeLow).toBeNull();

    const weeklyOnly = computePriorThresholds(null, WEEKLY, NOW);
    expect(weeklyOnly.week52High).toBeNull();
    expect(weeklyOnly.week52Low).toBeNull();
    expect(weeklyOnly.allTimeHigh).toBeNull();
  });

  it('returns all nulls when a ticker only has today\'s bar (IPO day)', () => {
    const ipoDaily: ChartBars = {
      timestamps: [ts('2026-07-16T13:30:00Z')],
      highs: [50],
      lows: [40],
    };
    const ipoWeekly: ChartBars = {
      timestamps: [ts('2026-07-13T13:30:00Z')],
      highs: [50],
      lows: [40],
    };
    const t = computePriorThresholds(ipoDaily, ipoWeekly, NOW);
    expect(t).toEqual({ week52High: null, week52Low: null, allTimeHigh: null, allTimeLow: null });
  });

  it('ignores null, non-positive, and length-mismatched bar data', () => {
    const messy: ChartBars = {
      timestamps: [
        ts('2026-07-14T13:30:00Z'),
        ts('2026-07-15T13:30:00Z'),
        NaN,
        ts('2026-07-15T13:30:00Z'), // no matching high/low entries
      ],
      highs: [null, 100, 0],
      lows: [null, -5, 90],
    };
    const t = computePriorThresholds(messy, null, NOW);
    expect(t.week52High).toBe(100);
    expect(t.week52Low).toBeNull(); // only invalid lows supplied
  });
});
