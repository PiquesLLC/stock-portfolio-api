import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * The migration-history invariant, enforced.
 *
 * Replaying every migration must produce exactly what schema.prisma describes.
 * That was NOT true before 2026-08-26: multi-portfolio shipped four columns and
 * four indexes straight to production, so a fresh replay built a schema neither
 * production nor schema.prisma agreed with — and the divergence was invisible
 * because `prisma migrate status` only compares the history TABLE, never the
 * actual shape.
 *
 * This test closes that blind spot. It is the check that would have caught the
 * drift when it was one migration old instead of months.
 *
 * Production's own accepted differences are deliberately NOT asserted here — they
 * are runtime-owned objects that cannot exist in a replay, and they are
 * registered in docs/database-schema-drift-exceptions-2026-08-26.md.
 */

const REPO = path.join(__dirname, '..', '..');
const MIGRATIONS = path.join(REPO, 'prisma', 'migrations');
const SCHEMA = path.join(REPO, 'prisma', 'schema.prisma');

function migrateDiff(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('npx', ['prisma', 'migrate', 'diff', ...args], {
      cwd: REPO, encoding: 'utf8', timeout: 240_000, shell: true,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

describe('migration history integrity', () => {
  it('replaying every migration reproduces schema.prisma exactly', () => {
    // --exit-code: 0 empty, 2 non-empty, 1 error. Called directly rather than
    // through a pipe, because a pipeline returns the LAST command's status and
    // would report success no matter what prisma said.
    const { code, out } = migrateDiff([
      '--from-migrations', MIGRATIONS,
      '--to-schema', SCHEMA,
      '--script', '--exit-code',
    ]);

    if (code === 2) {
      const sql = out.split('\n').filter((l) => l.trim() && !l.startsWith('--')).join('\n');
      throw new Error(
        'Migration history no longer matches schema.prisma.\n\n' +
        'Something changed schema.prisma without a migration, or changed production\n' +
        'directly. Do NOT baseline this away without classifying it first — see\n' +
        'docs/database-schema-drift-exceptions-2026-08-26.md for how the last\n' +
        'occurrence was repaired, and why marking a migration applied without\n' +
        'proving the objects exist is what caused it.\n\n' +
        `Prisma proposes:\n${sql}`,
      );
    }
    expect(code, `prisma migrate diff failed:\n${out}`).toBe(0);
  }, 300_000);

  it('every migration directory contains a migration.sql', () => {
    // An empty directory makes `migrate deploy` fail on a fresh environment.
    const empty = fs.readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => !fs.existsSync(path.join(MIGRATIONS, d.name, 'migration.sql')))
      .map((d) => d.name);
    expect(empty).toEqual([]);
  });

  it('the repair migration is idempotent in both directions', () => {
    /**
     * Load-bearing. Production is missing these objects, so the migration must
     * create them; a fresh replay already created them in 20260324_*, so it must
     * be a no-op there. A plain CREATE would repair production and then break
     * every fresh replay — the same mistake in the opposite direction.
     */
    const sql = fs.readFileSync(
      path.join(MIGRATIONS, '20260826_restore_missing_schema_objects', 'migration.sql'), 'utf8',
    );
    const creates = sql.split('\n').filter((l) => /^\s*CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX)/i.test(l));
    expect(creates.length).toBeGreaterThan(0);
    for (const line of creates) {
      expect(line, `not idempotent: ${line.trim()}`).toMatch(/IF NOT EXISTS/i);
    }
  });

  it('the baseline migration is additive only', () => {
    // Production records it as applied without running it, so it must never be
    // capable of destroying anything if it IS ever run somewhere.
    const sql = fs.readFileSync(
      path.join(MIGRATIONS, '20260826_reconcile_schema_history_baseline', 'migration.sql'), 'utf8',
    );
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(sql).not.toMatch(/writable_schema/i);
    expect(sql).not.toMatch(/CREATE TABLE "new_/i);   // no table rebuilds
  });

  it('no migration from 2026-08-26 onward rebuilds the User table', () => {
    /**
     * User is 1.38 GB: a copy-and-rename is an outage, and the Apple stage that
     * follows this repair adds a column to exactly this table.
     *
     * Scoped to NEW migrations because history is not clean and cannot be made
     * clean: 20260402171219_add_account_lockout rebuilt User via
     * CREATE TABLE "new_User". That is already applied in production, and
     * editing a shipped migration would break its checksum rather than repair
     * anything. The rule is forward-looking, and this asserts it going forward.
     */
    const CUTOFF = '20260826';
    const offenders = fs.readdirSync(MIGRATIONS)
      .filter((dir) => dir >= CUTOFF)
      .filter((dir) => fs.existsSync(path.join(MIGRATIONS, dir, 'migration.sql')))
      .filter((dir) => /CREATE TABLE "new_User"/i.test(fs.readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('records the one historical User rebuild, so it is known rather than forgotten', () => {
    // Documented, not silently tolerated. If this ever stops matching, someone
    // has edited shipped history and the checksums are now wrong.
    const legacy = path.join(MIGRATIONS, '20260402171219_add_account_lockout', 'migration.sql');
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.readFileSync(legacy, 'utf8')).toMatch(/CREATE TABLE "new_User"/i);
  });
});
