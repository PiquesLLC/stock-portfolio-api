/**
 * Schema-repair preflight. READ ONLY.
 *
 * The baseline migration is about to be recorded as applied WITHOUT running its
 * SQL. That is only legitimate if the database already has the semantic result
 * of every statement being skipped.
 *
 * ── WHAT BLOCKS, AND WHAT MERELY REPORTS ──────────────────────────────────
 *
 * CATEGORY B BLOCKS. It is the entire content of the baseline migration, so it
 * is the only thing that decides whether skipping that SQL is honest.
 *
 * Checking that an object with the right NAME exists is not enough, and the
 * reason is this repair's own root cause: 20260324_add_monitoring_reports and
 * 20260324_add_stripe_indexes are recorded as applied in production while their
 * objects were never created. A marker proved nothing then, and a name proves
 * little now — a `portfolioId` column of the wrong type, or an index over the
 * wrong columns, would be silently baselined into history as if it matched. So
 * every skipped statement is checked against what it would have produced:
 * column type/nullability/default/pk, index uniqueness and exact column order.
 *
 * CATEGORY A ONLY REPORTS. It appears in the OTHER migration, whose statements
 * are all `IF NOT EXISTS` precisely so that any starting state converges:
 * absent objects get created, present ones are skipped, a partial set is filled
 * in. Whether those objects exist says nothing about whether the baseline may
 * be resolved.
 *
 * Requiring them absent was correct while this ran once against one known
 * production shape. It became a deployment hazard the moment the same check
 * moved into a startup gate that must classify arbitrary databases: a database
 * with category B already correct AND category A already present is a perfectly
 * legitimate state, and failing it would exit non-zero on every boot, so the
 * container would never start.
 *
 * The inspection is shared with db-repair-gate.cjs, which must agree with this
 * script about what "present" means — if they disagree, the gate can route a
 * database into a repair this script then refuses.
 *
 * Usage (standalone, against a deployed container):
 *   base64 -w0 scripts/db-repair-preflight.cjs   -> $B64
 *   railway ssh "echo '$B64' | base64 -d > /app/preflight.cjs && node /app/preflight.cjs; rm -f /app/preflight.cjs"
 *
 * It must run from /app, not /tmp: Node resolves @libsql/client relative to the
 * script, and /tmp is outside the container's node_modules.
 */

const { createClient } = require('@libsql/client');
const { A_TABLES, A_INDEXES, inspectCategoryB, objectExists } = require('./db-repair-shared.cjs');

const db = createClient({ url: process.env.DATABASE_URL || 'file:/data/nala.db' });

let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
};

(async () => {
  console.log('CATEGORY B — must ALREADY satisfy every statement the baseline skips\n');

  const b = await inspectCategoryB(db);
  for (const r of b.results) check(r.state === 'correct', r.label, r.detail);

  console.log('\nCATEGORY A — reported only; the repair migration converges any state\n');

  let aPresent = 0;
  let aTotal = 0;
  for (const t of A_TABLES) {
    aTotal += 1;
    const present = await objectExists(db, 'table', t);
    if (present) aPresent += 1;
    console.log(`  info table ${t}: ${present ? 'present (repair will no-op)' : 'absent (repair will create)'}`);
  }
  for (const i of A_INDEXES) {
    aTotal += 1;
    const present = await objectExists(db, 'index', i);
    if (present) aPresent += 1;
    console.log(`  info index ${i}: ${present ? 'present (repair will no-op)' : 'absent (repair will create)'}`);
  }
  console.log(`  info ${aPresent}/${aTotal} category-A objects already present — not a pass/fail condition`);

  console.log(`\n${failures === 0 ? 'PREFLIGHT PASS — safe to resolve the baseline as applied'
    : `PREFLIGHT FAIL (${failures}) — STOP. Category B does not match what the baseline would produce.`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`  FAIL preflight errored: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
