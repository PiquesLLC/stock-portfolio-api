import { describe, expect, it } from 'vitest';
import { filterPerformanceShareCardPoints } from '../services/share-card.service';

describe('filterPerformanceShareCardPoints', () => {
  it('keeps only regular market hours for 1D performance cards', () => {
    const now = new Date('2026-03-13T23:15:00.000Z'); // 7:15 PM ET
    const points = [
      { time: new Date('2026-03-13T12:00:00.000Z').getTime(), value: 100 }, // 8:00 AM ET
      { time: new Date('2026-03-13T14:30:00.000Z').getTime(), value: 101 }, // 10:30 AM ET
      { time: new Date('2026-03-13T17:00:00.000Z').getTime(), value: 103 }, // 1:00 PM ET
      { time: new Date('2026-03-13T20:30:00.000Z').getTime(), value: 104 }, // 4:30 PM ET
      { time: new Date('2026-03-13T22:45:00.000Z').getTime(), value: 105 }, // 6:45 PM ET
    ];

    const filtered = filterPerformanceShareCardPoints(points, '1D', now);

    expect(filtered).toEqual([
      { time: new Date('2026-03-13T14:30:00.000Z').getTime(), value: 101 },
      { time: new Date('2026-03-13T17:00:00.000Z').getTime(), value: 103 },
    ]);
  });

  it('uses the latest trading day in the data when generated on a non-trading day', () => {
    const now = new Date('2026-03-14T18:00:00.000Z'); // Saturday 2:00 PM ET
    const points = [
      { time: new Date('2026-03-13T12:00:00.000Z').getTime(), value: 100 }, // Fri 8:00 AM ET
      { time: new Date('2026-03-13T15:30:00.000Z').getTime(), value: 102 }, // Fri 11:30 AM ET
      { time: new Date('2026-03-13T18:30:00.000Z').getTime(), value: 104 }, // Fri 2:30 PM ET
      { time: new Date('2026-03-13T22:30:00.000Z').getTime(), value: 103 }, // Fri 6:30 PM ET
      { time: new Date('2026-03-14T08:00:00.000Z').getTime(), value: 103 }, // Sat 4:00 AM ET
    ];

    const filtered = filterPerformanceShareCardPoints(points, '1D', now);

    expect(filtered).toEqual([
      { time: new Date('2026-03-13T15:30:00.000Z').getTime(), value: 102 },
      { time: new Date('2026-03-13T18:30:00.000Z').getTime(), value: 104 },
    ]);
  });

  it('falls back to the broader same-day session when regular-hours points are too sparse', () => {
    const now = new Date('2026-03-13T15:00:00.000Z'); // 11:00 AM ET
    const points = [
      { time: new Date('2026-03-13T09:30:00.000Z').getTime(), value: 98 }, // 5:30 AM ET
      { time: new Date('2026-03-13T11:00:00.000Z').getTime(), value: 99 }, // 7:00 AM ET
      { time: new Date('2026-03-13T14:45:00.000Z').getTime(), value: 100 }, // 10:45 AM ET
    ];

    const filtered = filterPerformanceShareCardPoints(points, '1D', now);

    expect(filtered).toEqual(points);
  });
});
