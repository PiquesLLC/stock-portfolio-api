// Unit tests for scheduleDailyAtUTC — the fixed-hour scheduler that replaced
// boot-anchored setInterval(24h) maintenance timing after the 2026-07-14
// outage (backup + retention + daily fleet all firing in the same minute).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleDailyAtUTC } from '../daily-schedule';

describe('scheduleDailyAtUTC', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires at the next occurrence of the given UTC time, not at boot', () => {
    vi.setSystemTime(new Date('2026-07-14T05:00:00.000Z'));
    const fn = vi.fn();
    const handle = scheduleDailyAtUTC(7, 10, fn, 'test-job');

    vi.advanceTimersByTime(2 * 60 * 60 * 1000); // 05:00 -> 07:00
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10 * 60 * 1000); // 07:00 -> 07:10
    expect(fn).toHaveBeenCalledTimes(1);
    handle.cancel();
  });

  it('rolls to tomorrow when the time has already passed today', () => {
    vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
    const fn = vi.fn();
    const handle = scheduleDailyAtUTC(7, 10, fn, 'test-job');

    vi.advanceTimersByTime(18 * 60 * 60 * 1000); // 12:00 -> 06:00 next day
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(70 * 60 * 1000); // 06:00 -> 07:10
    expect(fn).toHaveBeenCalledTimes(1);
    handle.cancel();
  });

  it('re-arms daily and keeps firing', () => {
    vi.setSystemTime(new Date('2026-07-14T07:00:00.000Z'));
    const fn = vi.fn();
    const handle = scheduleDailyAtUTC(7, 10, fn, 'test-job');

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(fn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(fn).toHaveBeenCalledTimes(3);
    handle.cancel();
  });

  it('keeps the schedule alive when a run throws synchronously', () => {
    vi.setSystemTime(new Date('2026-07-14T07:09:00.000Z'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fn = vi.fn(() => { throw new Error('boom'); });
    const handle = scheduleDailyAtUTC(7, 10, fn, 'test-job');

    vi.advanceTimersByTime(60 * 1000);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(fn).toHaveBeenCalledTimes(2); // still scheduled after the throw
    expect(consoleSpy).toHaveBeenCalled();
    handle.cancel();
  });

  it('cancel() stops future runs', () => {
    vi.setSystemTime(new Date('2026-07-14T07:00:00.000Z'));
    const fn = vi.fn();
    const handle = scheduleDailyAtUTC(7, 10, fn, 'test-job');
    handle.cancel();

    vi.advanceTimersByTime(48 * 60 * 60 * 1000);
    expect(fn).not.toHaveBeenCalled();
  });
});
