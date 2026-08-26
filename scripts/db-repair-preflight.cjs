/**
 * Schema-repair preflight. READ ONLY.
 *
 * The baseline migration is about to be recorded as applied WITHOUT running its
 * SQL. That is only legitimate if production already has the semantic result of
 * every statement being skipped.
 *
 * Checking that an object with the right NAME exists is not enough, and the
 * reason is this repair's own root cause: 20260324_add_monitoring_reports and
 * 20260324_add_stripe_indexes are recorded as applied while their objects were
 * never created. A marker proved nothing then, and a name proves little now — a
 * `portfolioId` column of the wrong type, or an index over the wrong columns,
 * would be silently baselined into history as if it matched.
 *
 * So every skipped statement is verified against what it would have produced:
 * column type/nullability/default/pk, and index uniqueness plus exact column
 * order.
 *
 * Category A is the mirror image: those objects must be genuinely ABSENT, since
 * the repair migration is what creates them.
 *
 * Usage (from the repo, against the deployed container):
 *   base64 -w0 scripts/db-repair-preflight.cjs   -> $B64
 *   railway ssh "echo '$B64' | base64 -d > /tmp/preflight.cjs && node /tmp/preflight.cjs; rm -f /tmp/preflight.cjs"
 */

const { createClient } = require('@libsql/client');

const db = createClient({ url: process.env.DATABASE_URL });

/** Category B — must already be TRUE in production (statements being skipped). */
const B_COLUMNS = ['DividendCredit', 'DividendReinvestment', 'Lot', 'PortfolioTrade']
  .map((table) => ({ table, column: 'portfolioId', type: 'TEXT', notnull: 0, dflt: null, pk: 0 }));

const B_INDEXES = [
  { name: 'DividendCredit_portfolioId_ticker_idx', table: 'DividendCredit', unique: 0, columns: ['portfolioId', 'ticker'] },
  { name: 'DividendReinvestment_portfolioId_ticker_idx', table: 'DividendReinvestment', unique: 0, columns: ['portfolioId', 'ticker'] },
  { name: 'Lot_portfolioId_ticker_idx', table: 'Lot', unique: 0, columns: ['portfolioId', 'ticker'] },
  { name: 'PortfolioTrade_portfolioId_ticker_idx', table: 'PortfolioTrade', unique: 0, columns: ['portfolioId', 'ticker'] },
];

/** Category A — must be ABSENT; the repair migration creates them. */
const A_TABLES = ['MonitoringReport'];
const A_INDEXES = [
  'MonitoringReport_type_createdAt_idx',
  'MonitoringReport_createdAt_idx',
  'ContentStrike_createdAt_idx',
  'CreatorPayout_stripeTransferId_idx',
  'CreatorPayout_stripePayoutId_idx',
  'CreatorSubscription_stripeSubscriptionId_idx',
];

const q = (sql, args = []) => db.execute({ sql, args });
let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
};

(async () => {
  console.log('CATEGORY B — production must ALREADY satisfy every skipped statement\n');

  for (const c of B_COLUMNS) {
    const rows = (await q('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)', [c.table]))
      .rows.filter((r) => String(r.name) === c.column);
    if (rows.length !== 1) { check(false, `${c.table}.${c.column}`, 'column not found'); continue; }
    const r = rows[0];
    const type = String(r.type ?? '').toUpperCase();
    const ok = type === c.type && Number(r.notnull) === c.notnull
      && (r.dflt_value === null || r.dflt_value === undefined) && Number(r.pk) === c.pk;
    check(ok, `${c.table}.${c.column}`,
      `type=${type} notnull=${Number(r.notnull)} default=${r.dflt_value === null ? 'NULL' : String(r.dflt_value)} pk=${Number(r.pk)}`);
  }

  for (const idx of B_INDEXES) {
    const listed = (await q('SELECT name, "unique", origin FROM pragma_index_list(?)', [idx.table]))
      .rows.filter((r) => String(r.name) === idx.name);
    if (listed.length !== 1) { check(false, `index ${idx.name}`, 'not found'); continue; }
    const cols = (await q('SELECT seqno, name FROM pragma_index_info(?) ORDER BY seqno', [idx.name]))
      .rows.map((r) => String(r.name));
    const ok = Number(listed[0].unique) === idx.unique
      && cols.length === idx.columns.length
      && cols.every((n, i) => n === idx.columns[i]);
    check(ok, `index ${idx.name}`, `unique=${Number(listed[0].unique)} columns=(${cols.join(', ')})`);
  }

  console.log('\nCATEGORY A — production must be MISSING these; the repair creates them\n');

  for (const t of A_TABLES) {
    const n = Number((await q('SELECT COUNT(*) n FROM sqlite_master WHERE type = ? AND name = ?', ['table', t])).rows[0].n);
    check(n === 0, `table ${t} absent`, n === 0 ? '' : 'ALREADY EXISTS');
  }
  for (const i of A_INDEXES) {
    const n = Number((await q('SELECT COUNT(*) n FROM sqlite_master WHERE type = ? AND name = ?', ['index', i])).rows[0].n);
    check(n === 0, `index ${i} absent`, n === 0 ? '' : 'ALREADY EXISTS');
  }

  console.log(`\n${failures === 0 ? 'PREFLIGHT PASS — safe to resolve the baseline as applied'
    : `PREFLIGHT FAIL (${failures}) — STOP. The A/B classification is wrong.`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.log(`  FAIL preflight errored: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
