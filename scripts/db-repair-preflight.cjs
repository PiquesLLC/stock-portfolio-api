/**
 * Schema-repair preflight. READ ONLY.
 *
 * Decides whether the baseline migration may be recorded as applied WITHOUT
 * running its SQL. That is only legitimate if the database already has the
 * semantic result of every statement being skipped.
 *
 * ── WHAT BLOCKS ───────────────────────────────────────────────────────────
 *
 * CATEGORY B must be entirely CORRECT. It is the whole content of the baseline
 * migration, so it alone decides whether skipping that SQL is honest. A name
 * check would not do: a portfolioId of the wrong type, or an index over the
 * wrong columns, would be baselined into history as if it matched — and a
 * marker that proves nothing is exactly this repair's root cause.
 *
 * CATEGORY A may be any mixture of CORRECT and ABSENT. Those objects belong to
 * the other migration and have no bearing on whether the baseline may be
 * resolved. Requiring them absent was right while this ran once against one
 * known production shape; it became a hazard once the same check moved into a
 * permanent startup gate, because a database with B correct and A present is
 * perfectly legitimate and would have failed to boot forever.
 *
 * But a WRONG-shaped category-A object still blocks. CREATE ... IF NOT EXISTS
 * converges absent objects and no-ops correct ones — it silently skips a
 * same-named object with a different definition. Letting that through would
 * record the repair migration as applied while the schema does not match what
 * it promises, which is the failure class this repair exists to remove.
 *
 * Usage (standalone, against a deployed container):
 *   base64 -w0 scripts/db-repair-preflight.cjs   -> $B64
 *   railway ssh "echo '$B64' | base64 -d > /app/db-repair-preflight.cjs && node /app/db-repair-preflight.cjs"
 *
 * Requires db-repair-shared.cjs alongside it, and must run from /app, not /tmp:
 * Node resolves @libsql/client relative to the script.
 */

const { createClient } = require('@libsql/client');
const { inspectCategoryB, inspectCategoryA } = require('./db-repair-shared.cjs');

const db = createClient({ url: process.env.DATABASE_URL || 'file:/data/nala.db' });

let failures = 0;
const line = (state, label, detail) => {
  const tag = state === 'correct' ? '  ok  ' : state === 'absent' ? '  info' : '  FAIL';
  console.log(`${tag} ${label}${detail ? `  (${detail})` : ''}`);
};

(async () => {
  console.log('CATEGORY B — must ALREADY satisfy every statement the baseline skips\n');
  const b = await inspectCategoryB(db);
  for (const r of b.results) {
    if (r.state !== 'correct') failures += 1;
    line(r.state === 'correct' ? 'correct' : 'wrong', r.label, r.detail);
  }

  console.log('\nCATEGORY A — correct or absent are both fine; WRONG blocks\n');
  const a = await inspectCategoryA(db);
  for (const r of a.results) {
    if (r.state === 'wrong') failures += 1;
    line(r.state, r.label,
      r.state === 'absent' ? 'absent — the repair migration will create it'
        : r.state === 'correct' ? `${r.detail} — the repair migration will no-op`
          : `${r.detail} — IF NOT EXISTS CANNOT FIX THIS`);
  }

  if (a.anyWrong) {
    console.log('');
    console.log('  A category-A object exists with the wrong definition. The repair migration');
    console.log('  uses CREATE ... IF NOT EXISTS, so it will skip that object rather than');
    console.log('  correct it, and the ledger would then claim a migration was applied whose');
    console.log('  promised schema is not present. An operator must reconcile the object by');
    console.log('  hand before this repair can proceed.');
  }

  console.log(`\n${failures === 0 ? 'PREFLIGHT PASS — safe to resolve the baseline as applied'
    : `PREFLIGHT FAIL (${failures}) — STOP.`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`  FAIL preflight errored: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
