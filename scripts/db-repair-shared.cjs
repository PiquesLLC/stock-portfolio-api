/**
 * Shared definitions for the 20260826 schema repair.
 *
 * The gate, the preflight and the post-deploy verifier must agree on what
 * "present" means, down to column type, default and index column ORDER. If they
 * drift apart, the gate can route a database into a repair whose preflight then
 * refuses it — which brings the container down permanently, because these run on
 * every boot.
 *
 * Everything here classifies an object as one of three states, never a boolean:
 *
 *   correct   matches what the migration would produce
 *   absent    not there at all
 *   wrong     same name, different definition
 *
 * The third state is why a name check is not enough. Both repair migrations use
 * CREATE ... IF NOT EXISTS, which converges *absent* objects and no-ops *correct*
 * ones — but it silently skips a same-named object with the wrong shape. A
 * name-only check would let the ledger record a migration as applied while the
 * schema does not match what that migration promises, which is the exact failure
 * class this whole repair exists to eliminate.
 */

/** Category B — the history gap. What the baseline migration's SQL would produce. */
const B_COLUMNS = ['DividendCredit', 'DividendReinvestment', 'Lot', 'PortfolioTrade']
  .map((table) => ({ table, name: 'portfolioId', type: 'TEXT', notnull: 0, dflt: null, pk: 0 }));

const B_INDEXES = [
  { name: 'DividendCredit_portfolioId_ticker_idx', table: 'DividendCredit', unique: 0, columns: ['portfolioId', 'ticker'] },
  { name: 'DividendReinvestment_portfolioId_ticker_idx', table: 'DividendReinvestment', unique: 0, columns: ['portfolioId', 'ticker'] },
  { name: 'Lot_portfolioId_ticker_idx', table: 'Lot', unique: 0, columns: ['portfolioId', 'ticker'] },
  { name: 'PortfolioTrade_portfolioId_ticker_idx', table: 'PortfolioTrade', unique: 0, columns: ['portfolioId', 'ticker'] },
];

/**
 * Category A — production's missing objects, exactly as 20260324_add_monitoring_reports
 * and 20260324_add_stripe_indexes define them. Copied from those migrations rather
 * than restated, so a repaired database is identical to a fresh replay.
 */
const A_TABLES = [{
  name: 'MonitoringReport',
  columns: [
    { name: 'id', type: 'TEXT', notnull: 1, dflt: null, pk: 1 },
    { name: 'type', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
    { name: 'data', type: 'TEXT', notnull: 1, dflt: '{}', pk: 0 },
    { name: 'source', type: 'TEXT', notnull: 1, dflt: 'scheduled-agent', pk: 0 },
    { name: 'createdAt', type: 'DATETIME', notnull: 1, dflt: 'CURRENT_TIMESTAMP', pk: 0 },
  ],
}];

const A_INDEXES = [
  { name: 'MonitoringReport_type_createdAt_idx', table: 'MonitoringReport', unique: 0, columns: ['type', 'createdAt'] },
  { name: 'MonitoringReport_createdAt_idx', table: 'MonitoringReport', unique: 0, columns: ['createdAt'] },
  { name: 'ContentStrike_createdAt_idx', table: 'ContentStrike', unique: 0, columns: ['createdAt'] },
  { name: 'CreatorPayout_stripeTransferId_idx', table: 'CreatorPayout', unique: 0, columns: ['stripeTransferId'] },
  { name: 'CreatorPayout_stripePayoutId_idx', table: 'CreatorPayout', unique: 0, columns: ['stripePayoutId'] },
  { name: 'CreatorSubscription_stripeSubscriptionId_idx', table: 'CreatorSubscription', unique: 0, columns: ['stripeSubscriptionId'] },
];

const objectExists = async (db, kind, name) => Number((await db.execute({
  sql: 'SELECT COUNT(*) n FROM sqlite_master WHERE type = ? AND name = ?',
  args: [kind, name],
})).rows[0].n) > 0;

/** SQLite stores a column default as its literal source text, quotes included. */
function normaliseDefault(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  const m = /^'(.*)'$/.exec(s);
  return m ? m[1] : s;
}

async function inspectColumn(db, table, spec) {
  const rows = (await db.execute({
    sql: 'SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)',
    args: [table],
  })).rows.filter((r) => String(r.name) === spec.name);

  if (rows.length === 0) return { state: 'absent', detail: 'not present' };
  const r = rows[0];
  const type = String(r.type ?? '').toUpperCase();
  const dflt = normaliseDefault(r.dflt_value);
  const ok = type === spec.type
    && Number(r.notnull) === spec.notnull
    && dflt === spec.dflt
    && Number(r.pk) === spec.pk;
  return {
    state: ok ? 'correct' : 'wrong',
    detail: `type=${type} notnull=${Number(r.notnull)} default=${dflt === null ? 'NULL' : dflt} pk=${Number(r.pk)}`,
  };
}

async function inspectIndex(db, spec) {
  if (!(await objectExists(db, 'index', spec.name))) return { state: 'absent', detail: 'not present' };

  const listed = (await db.execute({
    sql: 'SELECT name, "unique" FROM pragma_index_list(?)',
    args: [spec.table],
  })).rows.filter((r) => String(r.name) === spec.name);

  // Present in sqlite_master but not on the expected table: same name, different object.
  if (listed.length === 0) return { state: 'wrong', detail: `not an index on ${spec.table}` };

  const cols = (await db.execute({
    sql: 'SELECT seqno, name FROM pragma_index_info(?) ORDER BY seqno',
    args: [spec.name],
  })).rows.map((r) => String(r.name));
  const ok = Number(listed[0].unique) === spec.unique
    && cols.length === spec.columns.length
    && cols.every((n, i) => n === spec.columns[i]);
  return {
    state: ok ? 'correct' : 'wrong',
    detail: `unique=${Number(listed[0].unique)} columns=(${cols.join(', ')})`,
  };
}

const summarise = (results) => {
  const states = results.map((r) => r.state);
  return {
    results,
    allCorrect: states.every((s) => s === 'correct'),
    allAbsent: states.every((s) => s === 'absent'),
    anyWrong: states.some((s) => s === 'wrong'),
    wrong: results.filter((r) => r.state === 'wrong'),
  };
};

/** Category B: what the baseline migration would produce. */
async function inspectCategoryB(db) {
  const results = [];
  for (const c of B_COLUMNS) {
    const r = await inspectColumn(db, c.table, c);
    results.push({ label: `${c.table}.${c.name}`, ...r });
  }
  for (const idx of B_INDEXES) {
    const r = await inspectIndex(db, idx);
    results.push({ label: `index ${idx.name}`, ...r });
  }
  return summarise(results);
}

/**
 * Category A: what the repair migration would produce.
 *
 * A missing TABLE reports one 'absent' rather than one per column — the
 * migration creates it whole, so per-column detail would be noise.
 */
async function inspectCategoryA(db) {
  const results = [];
  for (const t of A_TABLES) {
    if (!(await objectExists(db, 'table', t.name))) {
      results.push({ label: `table ${t.name}`, state: 'absent', detail: 'not present' });
      continue;
    }
    const bad = [];
    for (const col of t.columns) {
      const r = await inspectColumn(db, t.name, col);
      if (r.state !== 'correct') bad.push(`${col.name}: ${r.detail}`);
    }
    results.push(bad.length === 0
      ? { label: `table ${t.name}`, state: 'correct', detail: `${t.columns.length} columns match` }
      : { label: `table ${t.name}`, state: 'wrong', detail: bad.join('; ') });
  }
  for (const idx of A_INDEXES) {
    const r = await inspectIndex(db, idx);
    results.push({ label: `index ${idx.name}`, ...r });
  }
  return summarise(results);
}

module.exports = {
  B_COLUMNS, B_INDEXES, A_TABLES, A_INDEXES,
  inspectCategoryB, inspectCategoryA, objectExists,
};
