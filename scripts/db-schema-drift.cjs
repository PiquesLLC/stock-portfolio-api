/**
 * Structural schema-drift comparison: production vs a database built purely from
 * migration history.
 *
 * WHY THIS EXISTS
 *
 * The 20260826 repair audited tables, columns and indexes. It never enumerated
 * TRIGGERS, and production turned out to be missing both Appeal.status
 * enforcement triggers -- recorded as applied, never executed. A category of
 * object that is not enumerated cannot be found missing.
 *
 * It also must not compare raw sqlite_master text. Production and a fresh replay
 * legitimately differ in whitespace and in IF NOT EXISTS, so a textual diff
 * buries real findings under formatting noise. Everything here is compared as
 * normalised facts: column shape, index shape, trigger/view semantics.
 *
 * Coverage: tables, columns, indexes, triggers, views.
 */

const { createClient } = require('@libsql/client');

const collapse = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();

/**
 * IF NOT EXISTS is stored verbatim by SQLite in sqlite_master.sql. A repaired
 * database creates the object through a repair migration that carries the
 * clause; a fresh replay creates it through the original migration that does
 * not. Same object, so the clause is normalised away.
 *
 * Case is deliberately PRESERVED: 'pending' and 'PENDING' are different values
 * to SQL, and lowercasing would hide a trigger that enforces the wrong set.
 */
const normaliseSql = (s) => collapse(String(s === null || s === undefined ? '' : s).replace(/\bIF\s+NOT\s+EXISTS\s+/gi, ''));

/** SQLite stores a column default as its literal source text, quotes included. */
const normaliseDefault = (v) => {
  if (v === null || v === undefined) return 'NULL';
  const s = collapse(v);
  const m = /^'(.*)'$/.exec(s);
  return m ? m[1] : s;
};

const whereClause = (sql) => {
  const m = /\bWHERE\b(.*)$/is.exec(String(sql === null || sql === undefined ? '' : sql));
  return m ? collapse(m[1]).replace(/["']/g, '') : '';
};

/**
 * Every schema object as `key -> normalised detail`. The key identifies the
 * object; the detail is what must match for it to be the SAME object.
 */
async function introspect(db) {
  const q = async (sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
  const facts = new Map();

  const tables = await q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  for (const t of tables) {
    facts.set(`table:${t.name}`, 'present');

    for (const c of await q('SELECT * FROM pragma_table_info(?)', [t.name])) {
      facts.set(
        `column:${t.name}.${c.name}`,
        `type=${collapse(c.type).toUpperCase()} notnull=${c.notnull} dflt=${normaliseDefault(c.dflt_value)} pk=${c.pk}`,
      );
    }

    for (const ix of await q('SELECT * FROM pragma_index_list(?)', [t.name])) {
      const cols = (await q('SELECT * FROM pragma_index_info(?)', [ix.name])).map((r) => r.name).join(',');
      const row = (await q("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", [ix.name]))[0];
      facts.set(
        `index:${t.name}.${ix.name}`,
        `unique=${ix.unique} partial=${ix.partial} cols=(${cols}) where=${whereClause(row && row.sql)}`,
      );
    }
  }

  for (const g of await q("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")) {
    facts.set(`trigger:${g.tbl_name}.${g.name}`, normaliseSql(g.sql));
  }

  for (const v of await q("SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name")) {
    facts.set(`view:${v.name}`, normaliseSql(v.sql));
  }

  return facts;
}

function diffFacts(live, reference) {
  const keys = [...new Set([...live.keys(), ...reference.keys()])].sort();
  const out = [];
  for (const key of keys) {
    const a = live.get(key);
    const b = reference.get(key);
    if (a === undefined) out.push({ key, kind: 'missing-from-live', live: null, reference: b });
    else if (b === undefined) out.push({ key, kind: 'extra-in-live', live: a, reference: null });
    else if (a !== b) out.push({ key, kind: 'differs', live: a, reference: b });
  }
  return out;
}

/**
 * The reviewed Category-C set. Each entry must be narrow enough that a NEW
 * problem in the same table still surfaces -- a blanket table-name exemption
 * would have hidden the Appeal triggers.
 */
const ACCEPTED_EXCEPTIONS = [
  {
    id: 'healthprobe-runtime-table',
    reason: 'HealthProbe is created and owned at runtime by the write probe, not by migration history.',
    matches: (d) => d.kind === 'extra-in-live' && /^(table|column|index|trigger):HealthProbe(\.|$)/.test(d.key),
  },
  {
    id: 'profilestatscache-implicit-unique',
    reason: 'ProfileStatsCache.userId is UNIQUE inline in production and a named index in history: same constraint, different representation.',
    matches: (d) => (
      (d.kind === 'extra-in-live'
        && d.key === 'index:ProfileStatsCache.sqlite_autoindex_ProfileStatsCache_2'
        && d.live === 'unique=1 partial=0 cols=(userId) where=')
      || (d.kind === 'missing-from-live'
        && d.key === 'index:ProfileStatsCache.ProfileStatsCache_userId_key'
        && d.reference === 'unique=1 partial=0 cols=(userId) where=')
    ),
  },
  {
    id: 'updatedat-db-default',
    reason: 'Appeal/Post/ValueRadarCache.updatedAt carry a CURRENT_TIMESTAMP database default in production; Prisma writes the value from the application layer.',
    matches: (d) => d.kind === 'differs'
      && ['column:Appeal.updatedAt', 'column:Post.updatedAt', 'column:ValueRadarCache.updatedAt'].includes(d.key)
      && d.live === String(d.reference).replace('dflt=NULL', 'dflt=CURRENT_TIMESTAMP'),
  },
];

function classify(differences, exceptions = ACCEPTED_EXCEPTIONS) {
  const explained = [];
  const unexplained = [];
  for (const d of differences) {
    const hit = exceptions.find((e) => e.matches(d));
    if (hit) explained.push({ ...d, exception: hit.id });
    else unexplained.push(d);
  }
  return { explained, unexplained };
}

async function factsFromUrl(url) {
  const db = createClient({ url });
  try {
    return await introspect(db);
  } finally {
    await db.close();
  }
}

async function compare(liveUrl, referenceUrl) {
  return classify(diffFacts(await factsFromUrl(liveUrl), await factsFromUrl(referenceUrl)));
}

module.exports = { introspect, diffFacts, classify, compare, factsFromUrl, ACCEPTED_EXCEPTIONS, normaliseSql };

if (require.main === module) {
  const fs = require('fs');
  const arg = (flag) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? null : process.argv[i + 1];
  };

  /**
   * Facts may come from a live URL or from a JSON file. Production runs in a
   * container that has no reference database next to it, so the honest way to
   * compare is to emit facts there with THIS code and diff them here -- rather
   * than reimplementing the normalisation in an ad-hoc script.
   */
  const resolve = async (urlFlag, factsFlag) => {
    const factsFile = arg(factsFlag);
    if (factsFile) return new Map(Object.entries(JSON.parse(fs.readFileSync(factsFile, 'utf8'))));
    const url = arg(urlFlag) || (urlFlag === '--live' ? process.env.DATABASE_URL : null);
    return url ? factsFromUrl(url) : null;
  };

  if (process.argv.includes('--emit-facts')) {
    resolve('--live', '--live-facts')
      .then((facts) => {
        if (!facts) throw new Error('--emit-facts needs --live <url> or DATABASE_URL');
        console.log(JSON.stringify(Object.fromEntries(facts)));
        process.exit(0);
      })
      .catch((err) => {
        console.error('[Drift] introspection failed:', err.message);
        process.exit(2);
      });
    return;
  }

  Promise.all([resolve('--live', '--live-facts'), resolve('--reference', '--reference-facts')])
    .then(([live, reference]) => {
      if (!live || !reference) {
        console.error('usage: node scripts/db-schema-drift.cjs --live <url|--live-facts f.json> --reference <url|--reference-facts f.json>');
        console.error('       node scripts/db-schema-drift.cjs --emit-facts --live <url>');
        process.exit(2);
      }
      return classify(diffFacts(live, reference));
    })
    .then(({ explained, unexplained }) => {
      for (const d of explained) console.log(`[Drift] accepted     ${d.key}  (${d.exception})`);
      for (const d of unexplained) {
        console.log(`[Drift] UNEXPLAINED  ${d.kind}  ${d.key}`);
        if (d.live !== null) console.log(`             live: ${d.live}`);
        if (d.reference !== null) console.log(`             hist: ${d.reference}`);
      }
      console.log(`[Drift] ${explained.length} accepted, ${unexplained.length} unexplained.`);
      process.exit(unexplained.length === 0 ? 0 : 1);
    })
    .catch((err) => {
      console.error('[Drift] comparison failed:', err.message);
      process.exit(2);
    });
}
