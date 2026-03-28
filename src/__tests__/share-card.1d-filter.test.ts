import { describe, expect, it } from 'vitest';
import { filterPerformanceShareCardPoints } from '../services/share-card.service';

describe('filterPerformanceShareCardPoints', () => {
  it('keeps 4 AM – 8 PM ET for 1D performance cards (matches in-app chart)', () => {
    const now = new Date('2026-03-13T23:15:00.000Z'); // 7:15 PM ET
    const points = [
      { time: new Date('2026-03-13T07:00:00.000Z').getTime(), value: 99 },  // 3:00 AM ET (excluded)
      { time: new Date('2026-03-13T08:00:00.000Z').getTime(), value: 100 }, // 4:00 AM ET (included)
      { time: new Date('2026-03-13T14:30:00.000Z').getTime(), value: 101 }, // 10:30 AM ET (included)
      { time: new Date('2026-03-13T17:00:00.000Z').getTime(), value: 103 }, // 1:00 PM ET (included)
      { time: new Date('2026-03-13T20:30:00.000Z').getTime(), value: 104 }, // 4:30 PM ET (included)
      { time: new Date('2026-03-13T22:45:00.000Z').getTime(), value: 105 }, // 6:45 PM ET (included)
      { time: new Date('2026-03-14T01:00:00.000Z').getTime(), value: 106 }, // 9:00 PM ET (excluded)
    ];

    const filtered = filterPerformanceShareCardPoints(points, '1D', now);

    expect(filtered).toEqual([
      { time: new Date('2026-03-13T08:00:00.000Z').getTime(), value: 100 },
      { time: new Date('2026-03-13T14:30:00.000Z').getTime(), value: 101 },
      { time: new Date('2026-03-13T17:00:00.000Z').getTime(), value: 103 },
      { time: new Date('2026-03-13T20:30:00.000Z').getTime(), value: 104 },
      { time: new Date('2026-03-13T22:45:00.000Z').getTime(), value: 105 },
    ]);
  });

  it('uses the latest trading day in the data when generated on a non-trading day', () => {
    const now = new Date('2026-03-14T18:00:00.000Z'); // Saturday 2:00 PM ET
    const points = [
      { time: new Date('2026-03-13T08:00:00.000Z').getTime(), value: 100 }, // Fri 4:00 AM ET (included)
      { time: new Date('2026-03-13T15:30:00.000Z').getTime(), value: 102 }, // Fri 11:30 AM ET (included)
      { time: new Date('2026-03-13T18:30:00.000Z').getTime(), value: 104 }, // Fri 2:30 PM ET (included)
      { time: new Date('2026-03-13T23:30:00.000Z').getTime(), value: 103 }, // Fri 7:30 PM ET (included)
      { time: new Date('2026-03-14T08:00:00.000Z').getTime(), value: 103 }, // Sat 4:00 AM ET (excluded — weekend)
    ];

    const filtered = filterPerformanceShareCardPoints(points, '1D', now);

    expect(filtered).toEqual([
      { time: new Date('2026-03-13T08:00:00.000Z').getTime(), value: 100 },
      { time: new Date('2026-03-13T15:30:00.000Z').getTime(), value: 102 },
      { time: new Date('2026-03-13T18:30:00.000Z').getTime(), value: 104 },
      { time: new Date('2026-03-13T23:30:00.000Z').getTime(), value: 103 },
    ]);
  });

  it('falls back to all trading day points when 4AM-8PM filter yields too few', () => {
    const now = new Date('2026-03-13T10:00:00.000Z'); // 6:00 AM ET — early morning
    const points = [
      { time: new Date('2026-03-13T09:00:00.000Z').getTime(), value: 98 },  // 5:00 AM ET (included in fallback)
      { time: new Date('2026-03-13T09:30:00.000Z').getTime(), value: 99 },  // 5:30 AM ET (included in fallback)
    ];

    const filtered = filterPerformanceShareCardPoints(points, '1D', now);

    // Falls back to all points on latest trading day since 4AM-8PM filter yields < 2
    expect(filtered).toEqual(points);
  });
});
