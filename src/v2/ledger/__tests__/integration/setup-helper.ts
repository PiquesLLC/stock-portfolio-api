// Integration-test setup helpers for the v2 ledger.
//
// These are loaded by integration test files. They:
//   1. Run migrations + seed against the live test Postgres (idempotent).
//   2. Provide a per-test truncate that bypasses the append-only triggers.
//
// Gating: integration tests check `process.env.RUN_V2_INTEGRATION === '1'`
// before calling these. Without the env, the tests `describe.skip` so CI
// without Postgres doesn't fail.

import { execSync } from 'child_process';
import { getLedgerClient } from '../../prisma';

let migrationsApplied = false;

/**
 * Apply v2 migrations + seed to the test Postgres. Idempotent — safe to
 * call from every integration test's beforeAll. Throws a clear error if
 * Postgres isn't reachable so the operator knows to `npm run v2:dev:up`.
 */
export async function applyMigrationsAndSeedIfNeeded(): Promise<void> {
  if (migrationsApplied) return;

  // Same hostname allowlist guard as truncateLedgerForTest — `prisma migrate
  // deploy` against a non-test DB could apply v2 migrations to production,
  // which is destructive in its own way.
  assertSafeTestDatabaseOrThrow();

  // Probe connection first so a missing docker compose surfaces a clear
  // message rather than 50 cryptic test failures.
  const url = process.env.V2_DATABASE_URL;
  if (!url) {
    throw new Error(
      'V2_DATABASE_URL is not set. Integration tests require Postgres. ' +
        'Run: docker compose up -d && export V2_DATABASE_URL=postgresql://nala_v2:dev_password_local_only@localhost:5432/nala_v2_ledger',
    );
  }

  try {
    execSync('npx prisma migrate deploy --config=./prisma-v2/prisma.config.ts', {
      stdio: 'pipe',
      env: { ...process.env, V2_DATABASE_URL: url },
      cwd: process.cwd(),
    });
  } catch (err) {
    const msg = (err as { stderr?: Buffer; message?: string }).stderr?.toString() ?? (err as Error).message;
    throw new Error(
      `Failed to apply v2 migrations to ${url}. Is Postgres running? ` +
        `Run: docker compose up -d postgres-v2\n\nUnderlying error:\n${msg}`,
    );
  }

  try {
    execSync('npx ts-node prisma-v2/seed.ts', {
      stdio: 'pipe',
      env: { ...process.env, V2_DATABASE_URL: url },
      cwd: process.cwd(),
    });
  } catch (err) {
    const msg = (err as { stderr?: Buffer; message?: string }).stderr?.toString() ?? (err as Error).message;
    throw new Error(`Failed to run v2 seed.\n\n${msg}`);
  }

  migrationsApplied = true;
}

/**
 * Hostname allowlist guard. truncateLedgerForTest disables the append-only
 * triggers and wipes ledger_entry + accounts — catastrophic if pointed at
 * production. The guard checks V2_DATABASE_URL against an allowlist of
 * test-DB hostnames and refuses to run if the URL doesn't match.
 *
 * Override via V2_TEST_DB_HOSTS env (comma-separated). Defaults to local
 * docker compose endpoints.
 */
function assertSafeTestDatabaseOrThrow(): void {
  const url = process.env.V2_DATABASE_URL ?? '';
  const allowlist = (process.env.V2_TEST_DB_HOSTS ?? 'localhost,127.0.0.1')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  const matched = allowlist.some((h) => url.includes(h));
  if (!matched) {
    const redacted = url.replace(/:[^:@]+@/, ':***@');
    throw new Error(
      `truncateLedgerForTest refused: V2_DATABASE_URL=${redacted} is not in the ` +
        `allowlist (${allowlist.join(', ')}). This guard prevents accidental ` +
        `wipes of non-test databases. Set V2_TEST_DB_HOSTS to include this host ` +
        `if the URL is intentional (e.g., a dedicated test DB on a remote box).`,
    );
  }
}

/**
 * Wipe ledger_entry + non-system accounts between tests. The append-only
 * triggers normally reject TRUNCATE/DELETE — we disable them transiently
 * for the truncate, then re-enable. This is safe in test code because we
 * own the Postgres instance and no production code path should ever do
 * this; the trigger remains the load-bearing protection in prod.
 *
 * Re-seeds the chart-of-accounts system accounts (stripe_clearing,
 * platform_revenue, platform_fee, tax_withholding) so every test starts
 * from a known shape.
 *
 * Hostname-guarded: refuses to run if V2_DATABASE_URL points at a host
 * not in the test allowlist. This is a defense-in-depth check on top of
 * the RUN_V2_INTEGRATION env gate.
 */
export async function truncateLedgerForTest(): Promise<void> {
  assertSafeTestDatabaseOrThrow();
  const prisma = getLedgerClient();

  // Disable append-only triggers. Order: TRUNCATE trigger first (since
  // we're about to TRUNCATE), then UPDATE/DELETE (defense in depth — the
  // TRUNCATE itself shouldn't fire these but cascade semantics vary).
  await prisma.$executeRawUnsafe(`
    ALTER TABLE ledger_entry DISABLE TRIGGER ledger_entry_reject_truncate;
    ALTER TABLE ledger_entry DISABLE TRIGGER ledger_entry_reject_update;
    ALTER TABLE ledger_entry DISABLE TRIGGER ledger_entry_reject_delete;
  `);

  // accounts CASCADE drags ledger_entry along via the FK. Both tables are
  // wiped in one statement.
  await prisma.$executeRawUnsafe(`TRUNCATE accounts, ledger_entry RESTART IDENTITY CASCADE;`);

  // Re-enable triggers.
  await prisma.$executeRawUnsafe(`
    ALTER TABLE ledger_entry ENABLE TRIGGER ledger_entry_reject_truncate;
    ALTER TABLE ledger_entry ENABLE TRIGGER ledger_entry_reject_update;
    ALTER TABLE ledger_entry ENABLE TRIGGER ledger_entry_reject_delete;
  `);

  // Re-seed the chart of accounts. Mirrors prisma-v2/seed.ts but inline
  // so we don't shell out per-test. accountId='platform' for all four
  // system accounts (single platform-wide ledger).
  const systemAccounts: Array<{ scope: string }> = [
    { scope: 'stripe_clearing' },
    { scope: 'platform_revenue' },
    { scope: 'platform_fee' },
    { scope: 'tax_withholding' },
  ];
  for (const a of systemAccounts) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO accounts (account_scope, account_id, currency, next_sequence_no, created_at)
       VALUES ('${a.scope}', 'platform', 'USD', 1, NOW())
       ON CONFLICT (account_scope, account_id) DO NOTHING`,
    );
  }
}

/**
 * Predicate to gate every integration `describe` block. Returns true when
 * the env is set up; false otherwise (test suite uses `describe.skipIf`).
 */
export function shouldRunIntegrationTests(): boolean {
  return process.env.RUN_V2_INTEGRATION === '1';
}
