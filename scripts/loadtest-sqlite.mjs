// SQLite write-contention load/soak harness — stock-portfolio-api
// ─────────────────────────────────────────────────────────────────────────────
// Reproduces the production write pattern (per-user PortfolioSnapshot + batched
// HoldingSnapshot, all through ONE shared libsql connection under WAL +
// busy_timeout=5000) to find the local write-contention ceiling and to validate
// the 2026-07-14 retention fix (chunked deletes + 300ms yields) under load.
//
// SAFETY: runs ONLY against a throwaway temp DB (os.tmpdir). It never opens
// prisma/dev.db and never touches production. Delete-safe, self-cleaning.
//
// Run:  node scripts/loadtest-sqlite.mjs
// Note: local NVMe/CPU differs from Railway's volume — numbers are directional
// for the *shape* of contention (where BUSY/head-of-line stalls begin), not an
// absolute prod capacity figure. See the caveats printed at the end.

import { createClient } from '@libsql/client';
import os from 'os';
import path from 'path';
import fs from 'fs';

const RUN_ID = `nala-loadtest-${Date.now()}`;
const DIR = path.join(os.tmpdir(), RUN_ID);
fs.mkdirSync(DIR, { recursive: true });
const DB_PATH = path.join(DIR, 'loadtest.db');
const DB_URL = `file:${DB_PATH}`;

const HOLDINGS_PER_SNAPSHOT = 20;   // typical portfolio breadth
const PHASE_SECONDS = 5;            // measurement window per concurrency level

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, monotonic
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBusy = (e) => /SQLITE_BUSY|database is locked|timed out|busy/i.test(e?.message || String(e));

async function applyPragmas(client) {
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA busy_timeout = 5000');
  await client.execute('PRAGMA auto_vacuum = INCREMENTAL');
}

async function createSchema(client) {
  // Mirror prisma/schema.prisma PortfolioSnapshot (:50) + HoldingSnapshot (:462)
  await client.execute(`CREATE TABLE IF NOT EXISTS PortfolioSnapshot (
    id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, totalValue REAL, cashBalance REAL,
    dailyPL REAL, dailyPLPercent REAL, totalPL REAL, totalPLPercent REAL,
    netEquity REAL, userId TEXT)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS ps_ts ON PortfolioSnapshot(timestamp)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS ps_user_ts ON PortfolioSnapshot(userId, timestamp)`);
  await client.execute(`CREATE TABLE IF NOT EXISTS HoldingSnapshot (
    id TEXT PRIMARY KEY, snapshotId TEXT NOT NULL, ticker TEXT NOT NULL,
    shares REAL, price REAL, marketValue REAL, dayPL REAL, dayPLPercent REAL, timestamp TEXT NOT NULL)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS hs_ticker_ts ON HoldingSnapshot(ticker, timestamp)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS hs_snap ON HoldingSnapshot(snapshotId)`);
}

let seq = 0;
const uid = (p) => `${p}-${(seq++).toString(36)}-${(Math.random() * 1e6 | 0).toString(36)}`;

// One "snapshot" = the exact prod 2-write pattern: 1 parent insert + 1 batched child insert.
async function writeSnapshot(client, userId) {
  const ts = new Date().toISOString();
  const snapId = uid('ps');
  await client.execute({
    sql: `INSERT INTO PortfolioSnapshot (id,timestamp,totalValue,cashBalance,dailyPL,dailyPLPercent,totalPL,totalPLPercent,netEquity,userId)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [snapId, ts, 100000 + Math.random() * 1e5, 5000, 12.3, 0.1, 4321, 4.2, 95000, userId],
  });
  const cols = [];
  const args = [];
  for (let i = 0; i < HOLDINGS_PER_SNAPSHOT; i++) {
    cols.push('(?,?,?,?,?,?,?,?,?)');
    args.push(uid('hs'), snapId, `TKR${i}`, 10 + i, 100 + i, (10 + i) * (100 + i), 1.2, 0.3, ts);
  }
  await client.execute({
    sql: `INSERT INTO HoldingSnapshot (id,snapshotId,ticker,shares,price,marketValue,dayPL,dayPLPercent,timestamp) VALUES ${cols.join(',')}`,
    args,
  });
}

// Run `depth` concurrent writer loops sharing ONE client for `seconds`. Returns stats.
async function runWriters(client, depth, seconds, extraLabel = '') {
  const deadline = nowMs() + seconds * 1000;
  const lat = [];
  let ok = 0, busy = 0, err = 0;
  async function worker(w) {
    while (nowMs() < deadline) {
      const t0 = nowMs();
      try {
        await writeSnapshot(client, `user-${w}`);
        lat.push(nowMs() - t0);
        ok++;
      } catch (e) {
        if (isBusy(e)) busy++; else { err++; if (err <= 2) console.log('   err:', e.message); }
      }
    }
  }
  await Promise.all(Array.from({ length: depth }, (_, w) => worker(w)));
  lat.sort((a, b) => a - b);
  const secs = seconds;
  return {
    depth, ok, busy, err,
    throughput: (ok / secs).toFixed(0),
    p50: pct(lat, 50).toFixed(1), p95: pct(lat, 95).toFixed(1),
    p99: pct(lat, 99).toFixed(1), max: (lat[lat.length - 1] || 0).toFixed(1),
    label: extraLabel,
  };
}

function walSizeMB() {
  try { return (fs.statSync(DB_PATH + '-wal').size / 1e6).toFixed(1); } catch { return '0.0'; }
}

async function main() {
  console.log(`\n=== SQLite contention load test — ${RUN_ID} ===`);
  console.log(`DB: ${DB_PATH}  (throwaway; prod uses WAL + busy_timeout=5000)\n`);

  const client = createClient({ url: DB_URL });
  await applyPragmas(client);
  await createSchema(client);

  // ── PHASE A — single-connection throughput ceiling (the app's real model:
  // all writes funnel through ONE connection). Ramp in-flight depth. ──────────
  console.log('PHASE A — single shared connection, ramping concurrency (prod scheduler = 8)');
  console.log('depth |  ok  | busy | err | wr/s |  p50  |  p95  |  p99  |  max   (latency ms, per full 2-write snapshot)');
  for (const depth of [1, 8, 16, 32, 64, 128]) {
    const s = await runWriters(client, depth, PHASE_SECONDS);
    console.log(`${String(depth).padStart(5)} | ${String(s.ok).padStart(4)} | ${String(s.busy).padStart(4)} | ${String(s.err).padStart(3)} | ${String(s.throughput).padStart(4)} | ${s.p50.padStart(5)} | ${s.p95.padStart(5)} | ${s.p99.padStart(5)} | ${s.max.padStart(6)}`);
  }
  console.log(`WAL after Phase A: ${walSizeMB()} MB\n`);

  // ── PHASE B — TWO connections competing for the single write lock (repro of
  // backup/stray-connection contention → real SQLITE_BUSY/P1008). ────────────
  console.log('PHASE B — two independent connections writing at once (repro multi-conn BUSY)');
  const client2 = createClient({ url: DB_URL });
  await client2.execute('PRAGMA busy_timeout = 5000');
  console.log('depth/conn |  ok  | busy(P1008) | note');
  for (const depth of [4, 8, 16, 32]) {
    const [a, b] = await Promise.all([
      runWriters(client, depth, PHASE_SECONDS),
      runWriters(client2, depth, PHASE_SECONDS),
    ]);
    const busyTotal = a.busy + b.busy;
    const okTotal = a.ok + b.ok;
    const errTotal = a.err + b.err;
    console.log(`${String(depth).padStart(10)} | ${String(okTotal).padStart(4)} | ${String(busyTotal).padStart(11)} | err=${errTotal} p99 c1=${a.p99}ms c2=${b.p99}ms`);
  }
  console.log(`WAL after Phase B: ${walSizeMB()} MB\n`);

  // ── PHASE C — retention fix validation. Snapshot writers steady at prod
  // concurrency 8 on the shared connection while a retention-style bulk delete
  // runs on the SAME connection: GOOD (chunk 1000 + 300ms yield) vs BAD (one
  // giant delete). Shows whether snapshot p99 stays bounded. ─────────────────
  console.log('PHASE C — retention under load: does the July fix keep snapshot latency bounded?');
  // Seed a deletable backlog of old rows.
  const OLD_TS = '2020-01-01T00:00:00.000+00:00';
  const SEED = 60000;
  const SEED_BATCH = 200; // keep bound params (×4) well under SQLite's limit
  process.stdout.write(`   seeding ${SEED} old rows... `);
  for (let i = 0; i < SEED; i += SEED_BATCH) {
    const cols = [], args = [];
    for (let j = 0; j < SEED_BATCH && i + j < SEED; j++) { cols.push('(?,?,?,?)'); args.push(uid('old'), OLD_TS, 1, `old-${i + j}`); }
    await client.execute({ sql: `INSERT INTO PortfolioSnapshot (id,timestamp,totalValue,userId) VALUES ${cols.join(',')}`, args });
  }
  console.log('done');

  async function retentionGood() {
    let total = 0;
    for (let c = 0; c < 500; c++) {
      const r = await client.execute({ sql: `DELETE FROM PortfolioSnapshot WHERE id IN (SELECT id FROM PortfolioSnapshot WHERE timestamp < ? LIMIT 1000)`, args: [OLD_TS.replace('2020', '2021')] });
      total += Number(r.rowsAffected || 0);
      if (Number(r.rowsAffected || 0) < 1000) break;
      await sleep(300); // the fix
    }
    return total;
  }
  async function retentionBad() {
    // One unbounded delete — the pre-fix shape that head-of-line-blocks the connection.
    const r = await client.execute({ sql: `DELETE FROM PortfolioSnapshot WHERE timestamp < ?`, args: [OLD_TS.replace('2020', '2021')] });
    return Number(r.rowsAffected || 0);
  }

  // Re-seed helper (Bad phase consumes the backlog).
  async function reseed(n) {
    for (let i = 0; i < n; i += SEED_BATCH) {
      const cols = [], args = [];
      for (let j = 0; j < SEED_BATCH && i + j < n; j++) { cols.push('(?,?,?,?)'); args.push(uid('old'), OLD_TS, 1, `old-${i + j}`); }
      await client.execute({ sql: `INSERT INTO PortfolioSnapshot (id,timestamp,totalValue,userId) VALUES ${cols.join(',')}`, args });
    }
  }

  for (const mode of ['GOOD (chunked + 300ms yield)', 'BAD (single unbounded delete)']) {
    await reseed(SEED);
    const isGood = mode.startsWith('GOOD');
    let deleted = 0;
    const writers = runWriters(client, 8, 8, mode); // 8s window, prod concurrency
    const ret = (isGood ? retentionGood() : retentionBad()).then((d) => { deleted = d; });
    const [s] = await Promise.all([writers, ret]);
    console.log(`   ${mode}`);
    console.log(`     snapshot writers during retention: ok=${s.ok} busy=${s.busy} p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms max=${s.max}ms  (deleted ${deleted} rows)`);
  }

  await client.close();
  await client2.close();

  // Cleanup
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(`\nCaveats: local disk/CPU ≠ Railway volume; absolute wr/s will differ, the CONTENTION SHAPE (BUSY onset, p99 under retention) is what transfers. Single shared connection is the true prod model. Cleanup done.`);
}

main().catch((e) => { console.error('LOADTEST FAILED:', e); process.exit(1); });
