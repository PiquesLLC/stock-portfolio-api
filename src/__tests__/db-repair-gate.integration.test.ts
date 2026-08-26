import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The startup repair gate's three-way decision, against real SQLite files.
 *
 * The dangerous mistake this guards against is misclassifying a FRESH database
 * as the drifted production one. A fresh database legitimately lacks the
 * category-B columns because history has not run yet; resolving the baseline
 * there would record a migration as applied whose SQL never executed — which is
 * exactly the defect being repaired, recreated by the repair itself.
 *
 * The gate therefore keys on the migration LEDGER, never on "does a table
 * exist" — tables in this deployment are also created by the startup DDL block,
 * so their presence says nothing about history.
 */

const REPO = path.join(__dirname, '..', '..');
const GATE = path.join(REPO, 'scripts', 'db-repair-gate.cjs');
const VERIFY = path.join(REPO, 'scripts', 'db-repair-verify.cjs');
const REPAIR = '20260826_restore_missing_schema_objects';
const BASELINE = '20260826_reconcile_schema_history_baseline';
const LATE_MARKER = '20260824000000_apple_authoritative_state';

/** 0 = repair needed, 10 = skip, 1 = error. */
function runGate(dbFile: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [GATE], {
      cwd: REPO, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, DATABASE_URL: `file:${dbFile.split(path.sep).join('/')}` },
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

/** 0 = repair verified, 1 = incomplete (boot must abort). */
function runVerify(dbFile: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [VERIFY], {
      cwd: REPO, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, DATABASE_URL: `file:${dbFile.split(path.sep).join('/')}` },
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

describe('startup schema-repair gate', () => {
  let dir: string;
  let file: string;
  let db: Client;

  const createLedger = async () => {
    await db.execute(`CREATE TABLE "_prisma_migrations" (
      "id" TEXT PRIMARY KEY, "checksum" TEXT NOT NULL, "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )`);
  };
  const addMigration = async (name: string, opts: { rolledBack?: boolean; unfinished?: boolean } = {}) => {
    await db.execute({
      sql: `INSERT INTO "_prisma_migrations" ("id","checksum","migration_name","finished_at","rolled_back_at","applied_steps_count")
            VALUES (?, ?, ?, ?, ?, 1)`,
      args: [
        `id-${name}`, 'deadbeef', name,
        opts.unfinished ? null : '2026-08-01T00:00:00.000Z',
        opts.rolledBack ? '2026-08-01T00:00:00.000Z' : null,
      ],
    });
  };

  /** The four tables the baseline migration touches, without portfolioId. */
  const createBTables = async () => {
    for (const t of ['DividendCredit', 'DividendReinvestment', 'Lot', 'PortfolioTrade']) {
      await db.execute(`CREATE TABLE "${t}" ("id" TEXT PRIMARY KEY, "ticker" TEXT)`);
    }
  };

  /** Exactly what the baseline migration would produce. */
  const addCategoryB = async () => {
    for (const t of ['DividendCredit', 'DividendReinvestment', 'Lot', 'PortfolioTrade']) {
      await db.execute(`ALTER TABLE "${t}" ADD COLUMN "portfolioId" TEXT`);
      await db.execute(`CREATE INDEX "${t}_portfolioId_ticker_idx" ON "${t}"("portfolioId", "ticker")`);
    }
  };

  /** What the 20260324_* migrations produce when they actually run. */
  const addCategoryA = async () => {
    await db.execute('CREATE TABLE "MonitoringReport" ("id" TEXT PRIMARY KEY, "type" TEXT, "createdAt" DATETIME)');
    await db.execute('CREATE INDEX "MonitoringReport_type_createdAt_idx" ON "MonitoringReport"("type", "createdAt")');
    await db.execute('CREATE INDEX "MonitoringReport_createdAt_idx" ON "MonitoringReport"("createdAt")');
    await db.execute('CREATE TABLE "ContentStrike" ("id" TEXT PRIMARY KEY, "createdAt" DATETIME)');
    await db.execute('CREATE INDEX "ContentStrike_createdAt_idx" ON "ContentStrike"("createdAt")');
    await db.execute('CREATE TABLE "CreatorPayout" ("id" TEXT PRIMARY KEY, "stripeTransferId" TEXT, "stripePayoutId" TEXT)');
    await db.execute('CREATE INDEX "CreatorPayout_stripeTransferId_idx" ON "CreatorPayout"("stripeTransferId")');
    await db.execute('CREATE INDEX "CreatorPayout_stripePayoutId_idx" ON "CreatorPayout"("stripePayoutId")');
    await db.execute('CREATE TABLE "CreatorSubscription" ("id" TEXT PRIMARY KEY, "stripeSubscriptionId" TEXT)');
    await db.execute('CREATE INDEX "CreatorSubscription_stripeSubscriptionId_idx" ON "CreatorSubscription"("stripeSubscriptionId")');
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-gate-'));
    file = path.join(dir, 'test.db');
    db = createClient({ url: `file:${file.split(path.sep).join('/')}` });
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
  });

  it('FRESH database: no ledger at all -> SKIP', async () => {
    // The case that must never be misread as production.
    await db.execute('CREATE TABLE "User" ("id" TEXT PRIMARY KEY)');   // tables exist, history does not
    const { code, out } = runGate(file);
    expect(code, out).toBe(10);
    expect(out).toContain('fresh database');
  });

  it('FRESH database: ledger table exists but is empty -> SKIP', async () => {
    await createLedger();
    const { code, out } = runGate(file);
    expect(code, out).toBe(10);
    expect(out).toContain('empty migration ledger');
  });

  it('DRIFTED PRODUCTION: late marker, baseline absent, category B ALREADY present -> REPAIR', async () => {
    await createLedger();
    await addMigration('20260101_something_old');
    await addMigration(LATE_MARKER);
    await createBTables();
    await addCategoryB();       // production has these; history never created them
    const { code, out } = runGate(file);
    expect(code, out).toBe(0);
    expect(out).toContain('repair required');
  });

  it('NORMAL CURRENT HISTORY: late marker, baseline absent, category B ABSENT -> SKIP', async () => {
    /**
     * The database this gate could brick. Any dev/staging environment built
     * from migrations reaches current history WITHOUT the portfolioId columns —
     * that gap is the whole reason the baseline exists — and with category A
     * present, because those migrations really ran there.
     *
     * Routing it into the repair would fail the preflight on every boot, and
     * this gate runs on every boot, so the container would never start again.
     * The baseline is ordinary pending work here: migrate deploy executes it.
     */
    await createLedger();
    await addMigration(LATE_MARKER);
    await createBTables();      // tables exist, portfolioId does NOT
    await addCategoryA();       // the 20260324_* migrations genuinely ran

    const { code, out } = runGate(file);
    expect(code, out).toBe(10);
    expect(out).toContain('entirely absent');
  });

  it('MIXED category B -> ABORT rather than guess', async () => {
    // Neither resolving nor executing the baseline is demonstrably safe.
    await createLedger();
    await addMigration(LATE_MARKER);
    await createBTables();
    await db.execute('ALTER TABLE "Lot" ADD COLUMN "portfolioId" TEXT');
    await db.execute('CREATE INDEX "Lot_portfolioId_ticker_idx" ON "Lot"("portfolioId", "ticker")');

    const { code, out } = runGate(file);
    expect(code, out).toBe(1);
    expect(out).toContain('MIXED OR UNEXPECTED');
  });

  it('WRONG-SHAPED category B -> ABORT (a name is not proof)', async () => {
    // portfolioId exists on every table, but one index is over the wrong
    // columns. Baselining that would record SQL as applied that did not
    // produce this state.
    await createLedger();
    await addMigration(LATE_MARKER);
    await createBTables();
    for (const t of ['DividendCredit', 'DividendReinvestment', 'Lot', 'PortfolioTrade']) {
      await db.execute(`ALTER TABLE "${t}" ADD COLUMN "portfolioId" TEXT`);
    }
    await db.execute('CREATE INDEX "DividendCredit_portfolioId_ticker_idx" ON "DividendCredit"("ticker", "portfolioId")');   // order swapped
    for (const t of ['DividendReinvestment', 'Lot', 'PortfolioTrade']) {
      await db.execute(`CREATE INDEX "${t}_portfolioId_ticker_idx" ON "${t}"("portfolioId", "ticker")`);
    }

    const { code, out } = runGate(file);
    expect(code, out).toBe(1);
  });

  it('ALREADY REPAIRED: baseline applied -> SKIP (every later boot)', async () => {
    await createLedger();
    await addMigration(LATE_MARKER);
    await addMigration(BASELINE);
    const { code, out } = runGate(file);
    expect(code, out).toBe(10);
    expect(out).toContain('already applied');
  });

  it('PARTIAL history: ledger populated but late marker missing -> SKIP', async () => {
    // migrate deploy applying the baseline normally is CORRECT for this database,
    // because its columns genuinely do not exist yet.
    await createLedger();
    await addMigration('20260101_something_old');
    await addMigration('20260500_middle_of_history');
    const { code, out } = runGate(file);
    expect(code, out).toBe(10);
    expect(out).toContain('mid-history');
  });

  it('a ROLLED BACK baseline row does not count as applied -> REPAIR', async () => {
    // Otherwise a failed attempt would permanently suppress the repair.
    await createLedger();
    await addMigration(LATE_MARKER);
    await createBTables();
    await addCategoryB();   // drifted-production shape
    await addMigration(BASELINE, { rolledBack: true });
    const { code, out } = runGate(file);
    expect(code, out).toBe(0);
  });

  it('an UNFINISHED baseline row does not count as applied -> REPAIR', async () => {
    await createLedger();
    await addMigration(LATE_MARKER);
    await createBTables();
    await addCategoryB();   // drifted-production shape
    await addMigration(BASELINE, { unfinished: true });
    const { code, out } = runGate(file);
    expect(code, out).toBe(0);
  });

  it('a rolled-back LATE MARKER is not treated as production history -> SKIP', async () => {
    await createLedger();
    await addMigration(LATE_MARKER, { rolledBack: true });
    const { code, out } = runGate(file);
    expect(code, out).toBe(10);
  });

  // ── post-deploy verification: the other half of the startup invariant ──

  it('VERIFY passes only when both migrations AND all seven objects exist', async () => {
    await createLedger();
    await addMigration(LATE_MARKER);
    await addMigration(BASELINE);
    await addMigration(REPAIR);
    await db.execute('CREATE TABLE "MonitoringReport" ("id" TEXT PRIMARY KEY, "type" TEXT, "createdAt" DATETIME)');
    for (const [idx, tbl, col] of [
      ['MonitoringReport_type_createdAt_idx','MonitoringReport','type'],
      ['MonitoringReport_createdAt_idx','MonitoringReport','createdAt'],
    ] as const) await db.execute(`CREATE INDEX "${idx}" ON "${tbl}"("${col}")`);
    await db.execute('CREATE TABLE "ContentStrike" ("id" TEXT PRIMARY KEY, "createdAt" DATETIME)');
    await db.execute('CREATE INDEX "ContentStrike_createdAt_idx" ON "ContentStrike"("createdAt")');
    await db.execute('CREATE TABLE "CreatorPayout" ("id" TEXT PRIMARY KEY, "stripeTransferId" TEXT, "stripePayoutId" TEXT)');
    await db.execute('CREATE INDEX "CreatorPayout_stripeTransferId_idx" ON "CreatorPayout"("stripeTransferId")');
    await db.execute('CREATE INDEX "CreatorPayout_stripePayoutId_idx" ON "CreatorPayout"("stripePayoutId")');
    await db.execute('CREATE TABLE "CreatorSubscription" ("id" TEXT PRIMARY KEY, "stripeSubscriptionId" TEXT)');
    await db.execute('CREATE INDEX "CreatorSubscription_stripeSubscriptionId_idx" ON "CreatorSubscription"("stripeSubscriptionId")');

    const { code, out } = runVerify(file);
    expect(code, out).toBe(0);
    expect(out).toContain('schema repair verified');
  });

  it('VERIFY REFUSES the boot when MonitoringReport is missing', async () => {
    // The exact production defect: recorded as applied, object absent.
    await createLedger();
    await addMigration(LATE_MARKER);
    await addMigration(BASELINE);
    await addMigration(REPAIR);

    const { code, out } = runVerify(file);
    expect(code, out).toBe(1);
    expect(out).toContain('REFUSING TO START');
    expect(out).toContain('resolve --rolled-back');   // tells the operator what to do
  });

  it('VERIFY REFUSES the boot when a migration row is missing', async () => {
    await createLedger();
    await addMigration(LATE_MARKER);
    await addMigration(BASELINE);   // repair migration absent
    const { code, out } = runVerify(file);
    expect(code, out).toBe(1);
  });

  it('VERIFY skips a fresh database rather than failing it', async () => {
    const { code, out } = runVerify(file);
    expect(code, out).toBe(0);
    expect(out).toContain('nothing to verify');
  });

  it('an unreadable database ABORTS the boot rather than guessing', () => {
    const missing = path.join(dir, 'nested', 'does-not-exist', 'x.db');
    const { code } = runGate(missing);
    // Neither 0 (repair) nor 10 (skip): the gate must not decide blind.
    expect([0, 10]).not.toContain(code);
  });
});
