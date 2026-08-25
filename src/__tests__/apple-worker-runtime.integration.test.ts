import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { Status } from '@apple/app-store-server-library';
import fs from 'fs';
import path from 'path';
import {
  startAppleReconciliationWorker,
  startAppleWorkerIfEnabled,
  getAppleWorkerStatus,
  isAppleWorkerEnabled,
  installAppleWorkerSignalHandlers,
  AppleWorkerAlreadyRunningError,
  AppleWorkerConfigError,
  __resetAppleWorkerForTests,
  WORKER_ENABLED_ENV,
} from '../services/apple-reconciliation-worker';
import {
  assertSupportedSingletonTopology,
  buildWorkerId,
  UnsupportedSingletonTopologyError,
} from '../services/apple-worker-topology';
import {
  requeueParkedAppleReconciliations,
  countParkedAppleReconciliations,
  RequeueScopeError,
  PARKED_THRESHOLD_MS,
  __PARK_EXCEEDS_THRESHOLD,
} from '../services/apple-parked-recovery';
import {
  __TEST_ONLY_ENQUEUE_SQL,
  PERMANENT_PARK_MS,
  type QueueClient,
  type AppleEnvironment,
} from '../services/apple-reconciliation-queue.service';
import { __resetAppleRateLimitersForTests } from '../services/apple-rate-limiter';
import type { AppleTransport } from '../services/apple-server-api';
import type { AppleTransportConfig } from '../services/apple-transport-factory';

/**
 * Worker runtime: singleton enforcement, shutdown, and operator recovery.
 *
 * The singleton story has three layers and only two are testable here — Railway
 * enforces the third by disallowing replicas on a volume-backed service. What IS
 * tested: the in-process guard, and the tripwire that turns a future topology
 * change into a boot failure rather than a silently doubled Apple request rate.
 */

const OTI = '2000000123456789';
const PRODUCT = 'nala_pro_monthly';
const MIGRATION = path.join(
  __dirname, '..', '..', 'prisma', 'migrations',
  '20260824000000_apple_authoritative_state', 'migration.sql',
);

const goodConfig: AppleTransportConfig = {
  auth: { issuerId: 'iss', keyId: 'kid', privateKey: 'pk', bundleId: 'com.nala.portfolio' },
  verifier: { bundleId: 'com.nala.portfolio', appAppleId: 123 },
};

const okResponse = (oti: string) => ({
  environment: 'Production',
  data: [{
    subscriptionGroupIdentifier: 'group-1',
    lastTransactions: [{
      outerOriginalTransactionId: oti,
      status: Status.ACTIVE,
      transaction: {
        transactionId: `txn-${oti}`, originalTransactionId: oti, productId: PRODUCT,
        subscriptionGroupIdentifier: 'group-1', expiresDate: Date.now() + 86_400_000,
      },
      renewal: { originalTransactionId: oti, autoRenewStatus: 1 },
    }],
  }],
});

describe('singleton topology tripwire', () => {
  const railway = {
    NODE_ENV: 'production',
    RAILWAY_SERVICE_ID: 'svc',
    RAILWAY_VOLUME_MOUNT_PATH: '/data',
    DATABASE_URL: 'file:/data/nala.db',
  } as NodeJS.ProcessEnv;

  it('accepts the volume-backed Railway topology the worker was designed for', () => {
    expect(assertSupportedSingletonTopology(railway)).toBe('railway-volume');
  });

  it('is unenforced outside production, so a local process can run one worker', () => {
    expect(assertSupportedSingletonTopology({ NODE_ENV: 'development' } as NodeJS.ProcessEnv))
      .toBe('unenforced-non-production');
  });

  it('FAILS CLOSED when the volume is gone — Railway could then run replicas', () => {
    const { RAILWAY_VOLUME_MOUNT_PATH: _drop, ...noVolume } = railway;
    expect(() => assertSupportedSingletonTopology(noVolume as NodeJS.ProcessEnv))
      .toThrow(UnsupportedSingletonTopologyError);
  });

  it('FAILS CLOSED when the database is no longer file-backed (the Postgres future)', () => {
    expect(() => assertSupportedSingletonTopology({
      ...railway, DATABASE_URL: 'postgresql://host/db',
    } as NodeJS.ProcessEnv)).toThrow(/reachable from multiple replicas/);
  });

  it('FAILS CLOSED when the database is not on the mounted volume', () => {
    expect(() => assertSupportedSingletonTopology({
      ...railway, DATABASE_URL: 'file:/tmp/elsewhere.db',
    } as NodeJS.ProcessEnv)).toThrow(/does not live under the mounted volume/);
  });

  it('FAILS CLOSED in production off Railway, where no platform guarantee exists', () => {
    const { RAILWAY_SERVICE_ID: _drop, ...offRailway } = railway;
    expect(() => assertSupportedSingletonTopology(offRailway as NodeJS.ProcessEnv))
      .toThrow(/not on Railway/);
  });

  it('worker id carries deployment identity AND a random boot component', () => {
    const env = { RAILWAY_DEPLOYMENT_ID: 'dep-1', RAILWAY_REPLICA_ID: 'rep-1' } as NodeJS.ProcessEnv;
    const a = buildWorkerId(env);
    const b = buildWorkerId(env);
    expect(a).toContain('dep-1');
    expect(a).toContain('rep-1');
    // Process identity must never double as fencing identity — the #34 lesson.
    expect(a).not.toBe(b);
  });
});

describe('apple worker runtime (real engine)', () => {
  let db: Client;
  const adapter: QueueClient = {
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) =>
      Number((await db.execute({ sql, args: args as never })).rowsAffected),
    $queryRawUnsafe: async <T,>(sql: string, ...args: unknown[]) =>
      (await db.execute({ sql, args: args as never })).rows as T[],
    $transaction: async <T,>(fn: (tx: QueueClient) => Promise<T>): Promise<T> => {
      await db.execute('BEGIN');
      try { const out = await fn(adapter); await db.execute('COMMIT'); return out; }
      catch (err) { await db.execute('ROLLBACK'); throw err; }
    },
  };
  const devEnv = { NODE_ENV: 'development', [WORKER_ENABLED_ENV]: 'true' } as NodeJS.ProcessEnv;

  const enqueue = async (oti = OTI, environment: AppleEnvironment = 'Production') => {
    const now = new Date().toISOString();
    await db.execute({ sql: __TEST_ONLY_ENQUEUE_SQL, args: [crypto.randomUUID(), environment, oti, now, now, now] });
  };
  const rows = async () =>
    (await db.execute(`SELECT * FROM "AppleReconciliation" ORDER BY "originalTransactionId"`)).rows as Record<string, unknown>[];
  const subCount = async () =>
    Number((await db.execute(`SELECT COUNT(*) AS n FROM "AppleSubscription"`)).rows[0].n);

  beforeEach(async () => {
    __resetAppleWorkerForTests();
    __resetAppleRateLimitersForTests();
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY)`);
    const sql = fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';')) { const s = stmt.trim(); if (s) await db.execute(s); }
  });
  afterEach(() => { db.close(); __resetAppleWorkerForTests(); __resetAppleRateLimitersForTests(); });

  const transportOf = (fn: AppleTransport['getAllSubscriptionStatuses']): AppleTransport =>
    ({ getAllSubscriptionStatuses: fn });

  it('processes queued work and records observability', async () => {
    await enqueue();
    const handle = startAppleReconciliationWorker({
      env: devEnv, transportConfig: goodConfig, maxPasses: 2, idleSleepMs: 1,
      deps: { client: adapter, transport: transportOf(async ({ originalTransactionId }) => okResponse(originalTransactionId) as never) },
    });
    await handle.done;

    expect(await subCount()).toBe(1);
    const s = getAppleWorkerStatus();
    expect(s.committedCount).toBe(1);
    expect(s.processedCount).toBeGreaterThanOrEqual(1);
    expect(s.workerId).toContain('apple-worker');
    expect(s.singletonMode).toBe('unenforced-non-production');
    expect(s.currentJob).toBeNull();          // identifiers only, cleared when idle
    expect(s.running).toBe(false);
  });

  it('IN-PROCESS GUARD: a second start is refused, and only one loop exists', async () => {
    const opts = {
      env: devEnv, transportConfig: goodConfig, maxPasses: 3, idleSleepMs: 1,
      deps: { client: adapter, transport: transportOf(async () => { throw new Error('no work expected'); }) },
    };
    const first = startAppleReconciliationWorker(opts);
    expect(() => startAppleReconciliationWorker(opts)).toThrow(AppleWorkerAlreadyRunningError);
    expect(getAppleWorkerStatus().workerId).toBe(first.workerId);
    await first.stop();
    // After it stops, a new one may start — the guard is about concurrency.
    const second = startAppleReconciliationWorker(opts);
    expect(second.workerId).not.toBe(first.workerId);
    await second.stop();
  });

  it('DISABLED: no worker, no Apple call, no topology assertion', async () => {
    await enqueue();
    let called = false;
    const handle = startAppleWorkerIfEnabled({
      // Production env with NO volume would fail the tripwire if it were reached.
      env: { NODE_ENV: 'production', [WORKER_ENABLED_ENV]: 'false' } as NodeJS.ProcessEnv,
      transportConfig: goodConfig,
      deps: { client: adapter, transport: transportOf(async () => { called = true; return okResponse(OTI) as never; }) },
    });
    expect(handle).toBeNull();
    expect(called).toBe(false);
    expect(getAppleWorkerStatus().enabled).toBe(false);
    expect(await subCount()).toBe(0);
    expect(isAppleWorkerEnabled({ [WORKER_ENABLED_ENV]: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('BAD CONFIG: refuses to start, by NAME, before claiming anything', async () => {
    await enqueue();
    let called = false;
    expect(() => startAppleReconciliationWorker({
      env: devEnv,
      transportConfig: { auth: { issuerId: '', keyId: '', privateKey: '', bundleId: '' }, verifier: { bundleId: '' } },
      deps: { client: adapter, transport: transportOf(async () => { called = true; return okResponse(OTI) as never; }) },
    })).toThrow(AppleWorkerConfigError);

    try {
      startAppleReconciliationWorker({
        env: devEnv,
        transportConfig: { auth: { issuerId: '', keyId: 'k', privateKey: 'p', bundleId: 'b' }, verifier: { bundleId: 'b', appAppleId: 1 } },
        deps: { client: adapter, transport: transportOf(async () => okResponse(OTI) as never) },
      });
    } catch (err) {
      expect((err as AppleWorkerConfigError).missing).toEqual(['APPLE_IAP_ISSUER_ID']);
    }
    expect(called).toBe(false);
    expect(await subCount()).toBe(0);   // nothing was claimed or reconciled
  });

  it('UNSUPPORTED TOPOLOGY: refuses to start even with valid config', async () => {
    expect(() => startAppleReconciliationWorker({
      env: { NODE_ENV: 'production', RAILWAY_SERVICE_ID: 'svc', DATABASE_URL: 'postgresql://h/d', [WORKER_ENABLED_ENV]: 'true' } as NodeJS.ProcessEnv,
      transportConfig: goodConfig,
      deps: { client: adapter, transport: transportOf(async () => okResponse(OTI) as never) },
    })).toThrow(UnsupportedSingletonTopologyError);
    expect(getAppleWorkerStatus().running).toBe(false);
  });

  it('SHUTDOWN: stop() prevents further claims but lets the current pass finish', async () => {
    await enqueue('oti-1');
    await enqueue('oti-2');

    let inFlight!: () => void;
    const gate = new Promise<void>((resolve) => { inFlight = resolve; });
    let passes = 0;
    let finishedFirst = false;

    const handle = startAppleReconciliationWorker({
      env: devEnv, transportConfig: goodConfig, idleSleepMs: 1,
      deps: {
        client: adapter,
        transport: transportOf(async ({ originalTransactionId }) => {
          passes += 1;
          if (passes === 1) { await gate; finishedFirst = true; }
          return okResponse(originalTransactionId) as never;
        }),
      },
    });

    // Ask it to stop while the first Apple call is still outstanding.
    const stopping = handle.stop();
    inFlight();                       // let the in-flight call complete
    await stopping;

    expect(finishedFirst).toBe(true); // the in-flight pass was allowed to finish
    expect(passes).toBe(1);           // and NO further job was claimed
    expect(await subCount()).toBe(1);
    expect(getAppleWorkerStatus().running).toBe(false);
  });

  it('SHUTDOWN: work interrupted mid-pass stays recoverable through the queue lease', async () => {
    await enqueue();
    // The transport hangs; we stop without letting it finish, as a crash would.
    const handle = startAppleReconciliationWorker({
      env: devEnv, transportConfig: goodConfig, idleSleepMs: 1,
      deps: { client: adapter, transport: transportOf(() => new Promise(() => { /* never resolves */ })) },
    });
    handle.stop();                     // do not await — the pass cannot complete
    await new Promise((r) => setTimeout(r, 30));

    const [row] = await rows();
    // Still claimed by that worker, with a lease that will expire and let another
    // worker reclaim it. The row was NOT force-released during shutdown.
    expect(String(row.reconcileState)).toBe('running');
    expect(row.leaseOwner).not.toBeNull();
    expect(row.leaseExpiresAt).not.toBeNull();
    expect(await subCount()).toBe(0);
  });

  it('signal handlers can be installed and removed without leaking listeners', async () => {
    const before = process.listenerCount('SIGTERM');
    const handle = startAppleReconciliationWorker({
      env: devEnv, transportConfig: goodConfig, maxPasses: 1, idleSleepMs: 1,
      deps: { client: adapter, transport: transportOf(async () => okResponse(OTI) as never) },
    });
    const remove = installAppleWorkerSignalHandlers(handle);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    remove();
    expect(process.listenerCount('SIGTERM')).toBe(before);
    await handle.stop();
  });
});

describe('parked-job operator recovery (real engine)', () => {
  let db: Client;
  const adapter: QueueClient = {
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) =>
      Number((await db.execute({ sql, args: args as never })).rowsAffected),
    $queryRawUnsafe: async <T,>(sql: string, ...args: unknown[]) =>
      (await db.execute({ sql, args: args as never })).rows as T[],
    $transaction: async <T,>(fn: (tx: QueueClient) => Promise<T>) => fn(adapter),
  };

  const seed = async (oti: string, environment: AppleEnvironment, nextAttemptMs: number, state = 'failed') => {
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO "AppleReconciliation"
            ("id","environment","originalTransactionId","targetGeneration","reconcileState","attemptCount","nextAttemptAt","lastError","createdAt","updatedAt")
            VALUES (?,?,?,1,?,3,?,'boom',?,?)`,
      args: [crypto.randomUUID(), environment, oti, state, new Date(Date.now() + nextAttemptMs).toISOString(), now, now],
    });
  };
  const row = async (oti: string) => (await db.execute({
    sql: `SELECT * FROM "AppleReconciliation" WHERE "originalTransactionId"=?`, args: [oti],
  })).rows[0] as Record<string, unknown>;

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY)`);
    const sql = fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';')) { const s = stmt.trim(); if (s) await db.execute(s); }
  });
  afterEach(() => db.close());

  it('the park constant is comfortably beyond the parked threshold', () => {
    expect(__PARK_EXCEEDS_THRESHOLD).toBe(true);
    expect(PERMANENT_PARK_MS).toBeGreaterThan(PARKED_THRESHOLD_MS);
  });

  it('requeues ONLY parked rows, never rows merely backing off', async () => {
    await seed('parked', 'Production', PERMANENT_PARK_MS);
    await seed('backing-off', 'Production', 30 * 60_000);   // ordinary backoff
    await seed('running-job', 'Production', PERMANENT_PARK_MS, 'running');

    const n = await requeueParkedAppleReconciliations({ environment: 'Production' }, { client: adapter });
    expect(n).toBe(1);

    const parked = await row('parked');
    expect(String(parked.reconcileState)).toBe('pending');
    expect(Number(parked.attemptCount)).toBe(0);
    expect(parked.lastError).toBeNull();
    expect(parked.leaseOwner).toBeNull();

    // An hour-long backoff must survive: waking it would undo the backoff.
    expect(String((await row('backing-off')).reconcileState)).toBe('failed');
    // A running job belongs to a live worker and must not be yanked.
    expect(String((await row('running-job')).reconcileState)).toBe('running');
  });

  it('scopes by environment and by originalTransactionId', async () => {
    await seed('p1', 'Production', PERMANENT_PARK_MS);
    await seed('s1', 'Sandbox', PERMANENT_PARK_MS);

    expect(await requeueParkedAppleReconciliations({ environment: 'Sandbox' }, { client: adapter })).toBe(1);
    expect(String((await row('p1')).reconcileState)).toBe('failed');   // untouched
    expect(String((await row('s1')).reconcileState)).toBe('pending');

    expect(await requeueParkedAppleReconciliations({ originalTransactionId: 'p1' }, { client: adapter })).toBe(1);
    expect(String((await row('p1')).reconcileState)).toBe('pending');
  });

  it('REFUSES an unscoped mass requeue without an explicit --all', async () => {
    await seed('p1', 'Production', PERMANENT_PARK_MS);
    await expect(requeueParkedAppleReconciliations({}, { client: adapter }))
      .rejects.toBeInstanceOf(RequeueScopeError);
    expect(String((await row('p1')).reconcileState)).toBe('failed');

    // ...and performs it when the operator says so explicitly.
    expect(await requeueParkedAppleReconciliations({ all: true }, { client: adapter })).toBe(1);
    expect(String((await row('p1')).reconcileState)).toBe('pending');
  });

  it('counts parked rows for before/after reporting', async () => {
    await seed('p1', 'Production', PERMANENT_PARK_MS);
    await seed('p2', 'Production', PERMANENT_PARK_MS);
    await seed('b1', 'Production', 60_000);
    expect(await countParkedAppleReconciliations({}, { client: adapter })).toBe(2);
    expect(await countParkedAppleReconciliations({ environment: 'Sandbox' }, { client: adapter })).toBe(0);
  });
});
