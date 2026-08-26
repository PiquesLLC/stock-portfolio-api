/**
 * Schema-repair preflight. READ ONLY.
 *
 * The baseline migration is about to be recorded as applied WITHOUT running its
 * SQL. That is only legitimate if the database already has the semantic result
 * of every statement being skipped.
 *
 * Checking that an object with the right NAME exists is not enough, and the
 * reason is this repair's own root cause: 20260324_add_monitoring_reports and
 * 20260324_add_stripe_indexes are recorded as applied in production while their
 * objects were never created. A marker proved nothing then, and a name proves
 * little now — a `portfolioId` column of the wrong type, or an index over the
 * wrong columns, would be silently baselined into history as if it matched.
 *
 * So every skipped statement is verified against what it would have produced:
 * column type/nullability/default/pk, and index uniqueness plus exact column
 * order. That inspection is shared with db-repair-gate.cjs, which must agree
 * with this script about what "present" means — if they disagree, the gate can
 * route a database into a repair this script then refuses, and the container
 * never starts.
 *
 * Category A is the mirror image: those objects must be genuinely ABSENT, since
 * the repair migration is what creates them.
 *
 * Usage (from the repo, against the deployed container):
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
  console.log('CATEGORY B — the database must ALREADY satisfy every skipped statement\n');

  const b = await inspectCategoryB(db);
  for (const r of b.results) check(r.state === 'correct', r.label, r.detail);

  console.log('\nCATEGORY A — must be MISSING here; the repair migration creates them\n');

  for (const t of A_TABLES) {
    const present = await objectExists(db, 'table', t);
    check(!present, `table ${t} absent`, present ? 'ALREADY EXISTS' : '');
  }
  for (const i of A_INDEXES) {
    const present = await objectExists(db, 'index', i);
    check(!present, `index ${i} absent`, present ? 'ALREADY EXISTS' : '');
  }

  console.log(`\n${failures === 0 ? 'PREFLIGHT PASS — safe to resolve the baseline as applied'
    : `PREFLIGHT FAIL (${failures}) — STOP. The A/B classification is wrong for this database.`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`  FAIL preflight errored: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
