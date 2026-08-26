/**
 * Shared definitions for the 20260826 schema repair.
 *
 * The gate and the preflight must agree on what "category B is present" means,
 * down to column type and index column ORDER. If they drift apart, the gate can
 * route a database into a repair whose preflight then refuses it — which brings
 * the container down permanently, because the gate runs on every boot.
 */

/** Category B — the history gap. What the baseline migration's SQL would produce. */
const B_COLUMNS = ['DividendCredit', 'DividendReinvestment', 'Lot', 'PortfolioTrade']
  .map((table) => ({ table, column: 'portfolioId', type: 'TEXT', notnull: 0, pk: 0 }));

const B_INDEXES = [
  { name: 'DividendCredit_portfolioId_ticker_idx', table: 'DividendCredit', unique: 0, columns: ['portfolioId', 'ticker'] },
  { name: 'DividendReinvestment_portfolioId_ticker_idx', table: 'DividendReinvestment', unique: 0, columns: ['portfolioId', 'ticker'] },
  { name: 'Lot_portfolioId_ticker_idx', table: 'Lot', unique: 0, columns: ['portfolioId', 'ticker'] },
  { name: 'PortfolioTrade_portfolioId_ticker_idx', table: 'PortfolioTrade', unique: 0, columns: ['portfolioId', 'ticker'] },
];

/** Category A — production's missing objects. The repair migration creates them. */
const A_TABLES = ['MonitoringReport'];
const A_INDEXES = [
  'MonitoringReport_type_createdAt_idx',
  'MonitoringReport_createdAt_idx',
  'ContentStrike_createdAt_idx',
  'CreatorPayout_stripeTransferId_idx',
  'CreatorPayout_stripePayoutId_idx',
  'CreatorSubscription_stripeSubscriptionId_idx',
];

/**
 * Classify each category-B object as 'correct', 'absent', or 'wrong'.
 *
 * 'wrong' matters as much as the other two: an object that exists with the wrong
 * shape means neither branch is demonstrably safe. Resolving the baseline would
 * record SQL as applied that did not produce this state, and executing it would
 * fail or compound the difference.
 */
async function inspectCategoryB(db) {
  const results = [];

  for (const c of B_COLUMNS) {
    const rows = (await db.execute({
      sql: 'SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)',
      args: [c.table],
    })).rows.filter((r) => String(r.name) === c.column);

    if (rows.length === 0) {
      results.push({ label: `${c.table}.${c.column}`, state: 'absent', detail: 'not present' });
      continue;
    }
    const r = rows[0];
    const type = String(r.type ?? '').toUpperCase();
    const ok = type === c.type
      && Number(r.notnull) === c.notnull
      && (r.dflt_value === null || r.dflt_value === undefined)
      && Number(r.pk) === c.pk;
    results.push({
      label: `${c.table}.${c.column}`,
      state: ok ? 'correct' : 'wrong',
      detail: `type=${type} notnull=${Number(r.notnull)} default=${r.dflt_value === null || r.dflt_value === undefined ? 'NULL' : String(r.dflt_value)} pk=${Number(r.pk)}`,
    });
  }

  for (const idx of B_INDEXES) {
    const listed = (await db.execute({
      sql: 'SELECT name, "unique" FROM pragma_index_list(?)',
      args: [idx.table],
    })).rows.filter((r) => String(r.name) === idx.name);

    if (listed.length === 0) {
      results.push({ label: `index ${idx.name}`, state: 'absent', detail: 'not present' });
      continue;
    }
    const cols = (await db.execute({
      sql: 'SELECT seqno, name FROM pragma_index_info(?) ORDER BY seqno',
      args: [idx.name],
    })).rows.map((r) => String(r.name));
    const ok = Number(listed[0].unique) === idx.unique
      && cols.length === idx.columns.length
      && cols.every((n, i) => n === idx.columns[i]);
    results.push({
      label: `index ${idx.name}`,
      state: ok ? 'correct' : 'wrong',
      detail: `unique=${Number(listed[0].unique)} columns=(${cols.join(', ')})`,
    });
  }

  const states = results.map((r) => r.state);
  return {
    results,
    allCorrect: states.every((s) => s === 'correct'),
    allAbsent: states.every((s) => s === 'absent'),
    anyWrong: states.some((s) => s === 'wrong'),
  };
}

const objectExists = async (db, kind, name) => Number((await db.execute({
  sql: 'SELECT COUNT(*) n FROM sqlite_master WHERE type = ? AND name = ?',
  args: [kind, name],
})).rows[0].n) > 0;

module.exports = { B_COLUMNS, B_INDEXES, A_TABLES, A_INDEXES, inspectCategoryB, objectExists };
