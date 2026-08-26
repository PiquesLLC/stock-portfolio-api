/**
 * 20260826 repair gate — decides WHETHER the baseline needs resolving. READ ONLY.
 *
 * Runs at container startup, before `node dist/index.js` opens the application
 * Prisma pool. That window matters: it is the only time this database is quiet
 * enough for Prisma's schema engine, which takes stronger-than-write locks and
 * fails with "database is locked" against a running app — proven on production,
 * seven deterministic attempts, while ordinary writers were acquiring
 * BEGIN IMMEDIATE in 1ms.
 *
 * ── THE CLASSIFICATION IS THE WHOLE JOB ───────────────────────────────────
 *
 * Four databases arrive here looking similar, and the wrong branch is
 * unrecoverable: this gate runs on EVERY boot, so a database routed into a
 * repair it does not need fails its preflight and never starts again.
 *
 *   fresh / uninitialised   No ledger. It legitimately lacks category B because
 *                           history has not run. Resolving the baseline would
 *                           record SQL that never executed — this exact defect,
 *                           recreated by its own repair.
 *                           -> SKIP; migrate deploy builds from history.
 *
 *   mid-history             Ledger exists but has not reached the late marker.
 *                           -> SKIP; migrate deploy applies the baseline
 *                           normally, which is correct there.
 *
 *   normal current history  Late marker applied, baseline absent, and category B
 *                           genuinely ABSENT because no migration ever created
 *                           it. This is any dev/staging database built from
 *                           history rather than production's manual drift.
 *                           -> SKIP; the baseline is ordinary pending work.
 *
 *   drifted production      Late marker applied, baseline absent, and category B
 *                           ALREADY PRESENT and correct.
 *                           -> REPAIR; resolving is safe precisely because the
 *                           SQL's effect already exists.
 *
 * The late marker only establishes "recent enough to need classifying". It
 * cannot pick the branch — category-B state does. Anything partial or
 * mis-shaped aborts, because then neither resolving nor executing the baseline
 * is demonstrably safe.
 *
 * Exit codes: 0 = repair needed, 10 = skip, 1 = error (caller must abort boot).
 */

const { createClient } = require('@libsql/client');
const { inspectCategoryB, objectExists } = require('./db-repair-shared.cjs');

const BASELINE = '20260826_reconcile_schema_history_baseline';

/**
 * Applied on every database carrying real history, and predates this repair.
 * Deliberately NOT a "does the User table exist" check: tables here are also
 * created by the startup DDL block, so their presence says nothing about history.
 */
const LATE_MARKER = '20260824000000_apple_authoritative_state';

const db = createClient({ url: process.env.DATABASE_URL || 'file:/data/nala.db' });
const say = (m) => console.log(`[RepairGate] ${m}`);

(async () => {
  if (!(await objectExists(db, 'table', '_prisma_migrations'))) {
    say('no _prisma_migrations table — fresh database. Skipping baseline repair.');
    process.exit(10);
  }

  const applied = async (name) => Number((await db.execute({
    sql: 'SELECT COUNT(*) n FROM _prisma_migrations WHERE migration_name = ? AND finished_at IS NOT NULL AND rolled_back_at IS NULL',
    args: [name],
  })).rows[0].n) > 0;

  const total = Number((await db.execute('SELECT COUNT(*) n FROM _prisma_migrations')).rows[0].n);
  if (total === 0) {
    say('empty migration ledger — fresh database. Skipping baseline repair.');
    process.exit(10);
  }

  if (await applied(BASELINE)) {
    say(`${BASELINE} already applied — nothing to do.`);
    process.exit(10);
  }

  if (!(await applied(LATE_MARKER))) {
    say(`ledger has ${total} rows but ${LATE_MARKER} is not applied — this database is`);
    say('mid-history. migrate deploy will apply the baseline normally, which is');
    say('correct here. Skipping.');
    process.exit(10);
  }

  // Recent enough to classify. Now the state itself decides.
  const b = await inspectCategoryB(db);
  for (const r of b.results) say(`  category B  ${r.state.padEnd(7)} ${r.label}  (${r.detail})`);

  if (b.allCorrect) {
    say(`existing history (${total} ledger rows) and category B already present — repair required.`);
    process.exit(0);
  }

  if (b.allAbsent) {
    say('category B is entirely absent — this database reached current history through');
    say('migrations, not through production’s manual drift. The baseline is ordinary');
    say('pending work: migrate deploy will execute it normally. Skipping.');
    process.exit(10);
  }

  say('');
  say('CATEGORY B IS IN A MIXED OR UNEXPECTED STATE (see the lines above).');
  say('Resolving the baseline would record SQL as applied that did not produce this');
  say('state; executing it would fail or compound the difference. Neither branch is');
  say('demonstrably safe, so this gate refuses to guess.');
  say('See docs/database-repair-runbook-2026-08-26.md');
  process.exit(1);
})().catch((err) => {
  say(`ERROR inspecting the migration ledger: ${err && err.message ? err.message : String(err)}`);
  say('Refusing to guess. Boot will abort.');
  process.exit(1);
});
