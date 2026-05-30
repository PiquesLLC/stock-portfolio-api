// Regression test for the daily prune filter — must NOT sweep one-shot
// snapshots like `nala-pre-cutover-<ISO-ts>.db` written by
// scripts/pre-cutover-snapshot.ts.
//
// pruneBackupsToKeep is the only prune function exported from
// backup.service.ts. pruneOldBackups (internal) uses the identical
// DAILY_BACKUP_REGEX filter via the same module-level constant, so this
// test covers both call paths' regex behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('../../utils/prisma', () => ({ default: { $queryRawUnsafe: vi.fn() } }));
vi.mock('@sentry/node', () => ({ captureMessage: vi.fn() }));

import { pruneBackupsToKeep, BACKUP_DIR } from '../backup.service';

describe('pruneBackupsToKeep daily-only filter', () => {
  let tmpDir: string;
  let originalBackupDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-prune-'));
    // Stub BACKUP_DIR by symlinking — the exported const is read at
    // import time, so we have to ensure the module sees the temp dir.
    // Easiest: write files to BACKUP_DIR if it's writable in the test
    // env. In CI this is `./prisma/backups` which is fine to create.
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    // Clean any leftover test files.
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      if (f.startsWith('nala-')) fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
  });

  afterEach(() => {
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      if (f.startsWith('nala-')) fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function touch(name: string, sizeBytes = 4096) {
    fs.writeFileSync(path.join(BACKUP_DIR, name), Buffer.alloc(sizeBytes));
  }

  it('keeps date-stamped daily backups only and ignores pre-cutover snapshots', () => {
    touch('nala-2026-05-28.db');
    touch('nala-2026-05-29.db');
    touch('nala-pre-cutover-2026-05-29T12-00-00-000Z.db');

    const result = pruneBackupsToKeep(1);

    // Pre-cutover should be untouched by the prune (NOT counted, NOT deleted).
    // Of the 2 dailies, the older one (2026-05-28) should be deleted.
    const deletedNames = result.deleted.map((d) => d.name);
    expect(deletedNames).toEqual(['nala-2026-05-28.db']);
    expect(deletedNames).not.toContain(
      expect.stringContaining('pre-cutover'),
    );
    expect(fs.existsSync(path.join(BACKUP_DIR, 'nala-pre-cutover-2026-05-29T12-00-00-000Z.db'))).toBe(true);
    expect(fs.existsSync(path.join(BACKUP_DIR, 'nala-2026-05-29.db'))).toBe(true);
    expect(fs.existsSync(path.join(BACKUP_DIR, 'nala-2026-05-28.db'))).toBe(false);
  });

  it('keeps multiple pre-cutover snapshots alongside dailies', () => {
    touch('nala-2026-05-29.db');
    touch('nala-pre-cutover-2026-05-29T12-00-00-000Z.db');
    touch('nala-pre-cutover-2026-05-29T18-30-00-000Z.db');

    pruneBackupsToKeep(1);

    // Both pre-cutover snapshots survive — they were never in the prune set.
    expect(fs.existsSync(path.join(BACKUP_DIR, 'nala-pre-cutover-2026-05-29T12-00-00-000Z.db'))).toBe(true);
    expect(fs.existsSync(path.join(BACKUP_DIR, 'nala-pre-cutover-2026-05-29T18-30-00-000Z.db'))).toBe(true);
    expect(fs.existsSync(path.join(BACKUP_DIR, 'nala-2026-05-29.db'))).toBe(true);
  });

  it('does not consider non-daily / non-snapshot filenames at all', () => {
    touch('nala-2026-05-29.db');
    touch('nala-temp.db'); // not daily shape, not pre-cutover — left alone
    touch('random.txt');   // doesn't start with nala-

    const result = pruneBackupsToKeep(1);

    expect(result.deleted).toHaveLength(0);
    expect(fs.existsSync(path.join(BACKUP_DIR, 'nala-temp.db'))).toBe(true);
    expect(fs.existsSync(path.join(BACKUP_DIR, 'random.txt'))).toBe(true);
  });
});
