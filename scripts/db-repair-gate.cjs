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
 * The decision has to distinguish three databases that look similar:
 *
 *   fresh / uninitialised   No ledger yet. It legitimately lacks the category-B
 *                           columns because history has not run. Resolving the
 *                           baseline here would mark a migration applied whose
 *                           SQL never ran — the exact defect this repairs.
 *                           -> SKIP, let migrate deploy build from history.
 *
 *   existing history        Ledger carries a known late migration, and the
 *                           baseline is absent. This is production.
 *                           -> REPAIR (caller then runs the semantic preflight).
 *
 *   already repaired        Baseline present. -> SKIP. Every boot after the
 *                           first lands here, which is what makes this safe to
 *                           leave in the startup path permanently.
 *
 * A partially-migrated database (ledger exists but has not reached the late
 * marker) also SKIPs: for such a database, migrate deploy applying the baseline
 * normally is CORRECT, because its columns genuinely do not exist yet.
 *
 * Exit codes: 0 = repair needed, 10 = skip, 1 = error (caller must abort boot).
 */

const { createClient } = require('@libsql/client');

const BASELINE = '20260826_reconcile_schema_history_baseline';

/**
 * A migration that is applied on every database carrying real history, and that
 * predates this repair. Deliberately NOT a "does the User table exist" check:
 * tables can be created by the startup DDL block without any history at all,
 * which would misclassify a fresh database as production.
 */
const LATE_MARKER = '20260824000000_apple_authoritative_state';

const db = createClient({ url: process.env.DATABASE_URL || 'file:/data/nala.db' });
const say = (m) => console.log(`[RepairGate] ${m}`);

(async () => {
  const ledgerExists = Number((await db.execute({
    sql: 'SELECT COUNT(*) n FROM sqlite_master WHERE type = ? AND name = ?',
    args: ['table', '_prisma_migrations'],
  })).rows[0].n) > 0;

  if (!ledgerExists) {
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
    say('mid-history, not the drifted production database. migrate deploy will apply the');
    say('baseline normally, which is correct here. Skipping.');
    process.exit(10);
  }

  say(`existing history (${total} ledger rows), baseline absent — repair required.`);
  process.exit(0);
})().catch((err) => {
  say(`ERROR inspecting the migration ledger: ${err && err.message ? err.message : String(err)}`);
  say('Refusing to guess. Boot will abort.');
  process.exit(1);
});
