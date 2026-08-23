import { describe, it, expect, vi, beforeEach } from 'vitest';

// Only readFileSync is replaced — existsSync and the rest stay real, because the
// ledger's own path resolution uses them and module-init elsewhere depends on them.
const readFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: readFileSyncMock };
});

import { readSelfRestartLedger } from '../services/db-watchdog.service';

// The self-restart ledger IS the crash-loop bound: it is the only thing that
// survives a restart to say how many restarts have already happened. Every
// failure mode here has to degrade to "no restarts recorded" rather than throw,
// because a ledger that throws would take the watchdog down with it — but note
// that degrading that way SPENDS no budget, so an unreadable ledger means the
// bound is not really enforced. That is why recordSelfRestart logs on failure.
describe('readSelfRestartLedger', () => {
  const now = new Date('2026-08-23T12:00:00.000Z').getTime();
  const hoursAgo = (h: number): number => now - h * 3_600_000;

  beforeEach(() => {
    readFileSyncMock.mockReset();
  });

  it('returns no restarts when the ledger does not exist yet', () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });
    expect(readSelfRestartLedger(now)).toEqual([]);
  });

  it('tolerates a corrupt ledger rather than throwing into the probe', () => {
    readFileSyncMock.mockReturnValue('{ this is not json');
    expect(readSelfRestartLedger(now)).toEqual([]);
  });

  it('ignores a ledger that is valid JSON but not an array', () => {
    readFileSyncMock.mockReturnValue('{"restarts": 3}');
    expect(readSelfRestartLedger(now)).toEqual([]);
  });

  it('drops non-numeric entries rather than counting them toward the budget', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify([hoursAgo(1), 'yesterday', null, hoursAgo(2)]));
    expect(readSelfRestartLedger(now)).toEqual([hoursAgo(1), hoursAgo(2)]);
  });

  it('counts restarts inside the rolling window', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify([hoursAgo(1), hoursAgo(3), hoursAgo(5)]));
    expect(readSelfRestartLedger(now)).toHaveLength(3);
  });

  it('forgets restarts older than the window, so the budget recovers on its own', () => {
    // 7h and 30h ago are outside the 6h window; a service that wedged once last
    // week must not be permanently barred from healing itself today.
    readFileSyncMock.mockReturnValue(JSON.stringify([hoursAgo(30), hoursAgo(7), hoursAgo(2)]));
    expect(readSelfRestartLedger(now)).toEqual([hoursAgo(2)]);
  });
});
