/**
 * 20260826 repair verification — runs AFTER `prisma migrate deploy`. READ ONLY.
 *
 * This is a startup invariant, not a warning. If the repair did not land, the
 * process exits nonzero and the application never starts, because booting
 * against a half-repaired database is how "applied but absent" was created in
 * the first place: MonitoringReport is recorded as applied in production while
 * its table does not exist, and the application writes to it.
 *
 * Verification is SEMANTIC, and by this point stricter than the preflight was.
 * Before the migration, a category-A object could legitimately be absent — the
 * migration was about to create it. Afterwards nothing may be absent, and
 * nothing may be wrong-shaped either: CREATE ... IF NOT EXISTS skips a
 * same-named object with a different definition, so a name check here would let
 * the ledger claim a migration was applied whose promised schema is not there.
 * That is precisely the failure class being repaired.
 *
 * Skips entirely on a fresh database, where the two repair migrations are
 * ordinary history rather than a repair.
 */

const { createClient } = require('@libsql/client');
const { inspectCategoryA, objectExists } = require('./db-repair-shared.cjs');

const BASELINE = '20260826_reconcile_schema_history_baseline';
const REPAIR = '20260826_restore_missing_schema_objects';

const db = createClient({ url: process.env.DATABASE_URL || 'file:/data/nala.db' });
const say = (m) => console.log(`[RepairVerify] ${m}`);
let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  say(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
};

(async () => {
  if (!(await objectExists(db, 'table', '_prisma_migrations'))) {
    say('no migration ledger — nothing to verify.');
    process.exit(0);
  }

  const applied = async (name) => Number((await db.execute({
    sql: 'SELECT COUNT(*) n FROM _prisma_migrations WHERE migration_name = ? AND finished_at IS NOT NULL AND rolled_back_at IS NULL',
    args: [name],
  })).rows[0].n) > 0;

  check(await applied(BASELINE), `${BASELINE} applied`);
  check(await applied(REPAIR), `${REPAIR} applied`);

  const a = await inspectCategoryA(db);
  for (const r of a.results) {
    check(r.state === 'correct', r.label,
      r.state === 'correct' ? r.detail
        : r.state === 'absent' ? 'MISSING after the repair migration'
          : `WRONG SHAPE — ${r.detail}`);
  }

  if (failures > 0) {
    say('');
    say('*********************************************************************');
    say(`SCHEMA REPAIR INCOMPLETE (${failures} failed checks). REFUSING TO START.`);
    say('');
    say('The application writes to MonitoringReport; starting against a database');
    say('missing it, or carrying a differently-shaped copy of it, repeats the');
    say('defect this repair exists to fix.');
    say('');
    if (a.anyWrong) {
      say('At least one object exists with the WRONG DEFINITION. The repair migration');
      say('uses CREATE ... IF NOT EXISTS and will keep skipping it on every retry —');
      say('this will not resolve itself. An operator must reconcile that object by');
      say('hand against the definition in the 20260324_* migrations.');
      say('');
    }
    say('The restart policy will retry this boot and it will fail the same way.');
    say('An operator must resolve it:');
    say('');
    say('  1. railway ssh "cd /app && npx prisma migrate status"');
    say(`  2. if ${REPAIR} is recorded FAILED:`);
    say(`       npx prisma migrate resolve --rolled-back ${REPAIR}`);
    say('       npx prisma migrate deploy        # safe: every statement is IF NOT EXISTS');
    say('  3. if all objects exist AND match their definitions, and only the ledger');
    say('     entry is wrong:');
    say(`       npx prisma migrate resolve --applied ${REPAIR}`);
    say('');
    say('Never hand-edit _prisma_migrations — that is what created this drift.');
    say('See docs/database-repair-runbook-2026-08-26.md');
    say('*********************************************************************');
    process.exit(1);
  }

  say('schema repair verified.');
  process.exit(0);
})().catch((err) => {
  say(`ERROR verifying the repair: ${err && err.message ? err.message : String(err)}`);
  say('Refusing to start against an unverified database.');
  process.exit(1);
});
