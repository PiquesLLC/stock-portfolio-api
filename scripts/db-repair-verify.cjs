/**
 * 20260826 repair verification — runs AFTER `prisma migrate deploy`. READ ONLY.
 *
 * This is a startup invariant, not a warning. If the repair did not land, the
 * process exits nonzero and the application never starts, because booting
 * against a half-repaired database is how "applied but absent" was created in
 * the first place: MonitoringReport is recorded as applied in production while
 * its table does not exist, and the application writes to it.
 *
 * Skips entirely on a fresh database, where the two repair migrations are
 * ordinary history rather than a repair.
 */

const { createClient } = require('@libsql/client');

const BASELINE = '20260826_reconcile_schema_history_baseline';
const REPAIR = '20260826_restore_missing_schema_objects';

const REQUIRED_TABLES = ['MonitoringReport'];
const REQUIRED_INDEXES = [
  'MonitoringReport_type_createdAt_idx',
  'MonitoringReport_createdAt_idx',
  'ContentStrike_createdAt_idx',
  'CreatorPayout_stripeTransferId_idx',
  'CreatorPayout_stripePayoutId_idx',
  'CreatorSubscription_stripeSubscriptionId_idx',
];

const db = createClient({ url: process.env.DATABASE_URL || 'file:/data/nala.db' });
const say = (m) => console.log(`[RepairVerify] ${m}`);
let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  say(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
};

(async () => {
  const ledgerExists = Number((await db.execute({
    sql: 'SELECT COUNT(*) n FROM sqlite_master WHERE type = ? AND name = ?',
    args: ['table', '_prisma_migrations'],
  })).rows[0].n) > 0;
  if (!ledgerExists) { say('no migration ledger — nothing to verify.'); process.exit(0); }

  const applied = async (name) => Number((await db.execute({
    sql: 'SELECT COUNT(*) n FROM _prisma_migrations WHERE migration_name = ? AND finished_at IS NOT NULL AND rolled_back_at IS NULL',
    args: [name],
  })).rows[0].n) > 0;

  check(await applied(BASELINE), `${BASELINE} applied`);
  check(await applied(REPAIR), `${REPAIR} applied`);

  const obj = async (kind, name) => Number((await db.execute({
    sql: 'SELECT COUNT(*) n FROM sqlite_master WHERE type = ? AND name = ?',
    args: [kind, name],
  })).rows[0].n) > 0;

  for (const t of REQUIRED_TABLES) check(await obj('table', t), `table ${t} exists`);
  for (const i of REQUIRED_INDEXES) check(await obj('index', i), `index ${i} exists`);

  if (failures > 0) {
    say('');
    say('*********************************************************************');
    say(`SCHEMA REPAIR INCOMPLETE (${failures} failed checks). REFUSING TO START.`);
    say('');
    say('The application writes to MonitoringReport; starting against a database');
    say('missing it repeats the defect this repair exists to fix.');
    say('');
    say('The restart policy will retry this boot and it will fail the same way.');
    say('An operator must resolve it:');
    say('');
    say('  1. railway ssh "cd /app && npx prisma migrate status"');
    say(`  2. if ${REPAIR} is recorded FAILED:`);
    say(`       npx prisma migrate resolve --rolled-back ${REPAIR}`);
    say('       npx prisma migrate deploy        # safe: every statement is IF NOT EXISTS');
    say('  3. if all objects exist and only the ledger entry is wrong:');
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
