import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { Status } from '@apple/app-store-server-library';
import fs from 'fs';
import path from 'path';
import {
  startAppleWorker,
  __TEST_ONLY_startAppleWorker,
  __TEST_ONLY_runLoop,
  getAppleWorkerStatus,
  isAppleWorkerEnabled,
  AppleWorkerAlreadyRunningError,
  AppleWorkerConfigError,
  __resetAppleWorkerForTests,
  WORKER_ENABLED_ENV,
} from '../services/apple-reconciliation-worker';
import {
  assertSupportedSingletonTopology,
  buildWorkerId,
  isPathContained,
  resolveFileDbPath,
  UnsupportedSingletonTopologyError,
} from '../services/apple-worker-topology';
import {
  requeueParkedAppleReconciliations,
  countParkedAppleReconciliations,
  assertRequeueScope,
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

/**
 * Worker runtime: singleton enforcement, gating, shutdown and operator recovery.
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

/** A complete, valid IAP environment — the worker builds its config from this. */
const goodEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  [WORKER_ENABLED_ENV]: 'true',
  NODE_ENV: 'development',
  APPLE_IAP_ISSUER_ID: 'iss', APPLE_IAP_KEY_ID: 'kid', APPLE_IAP_PRIVATE_KEY: 'pk',
  APPLE_BUNDLE_ID: 'com.nala.portfolio', APPLE_APP_APPLE_ID: '123',
  ...over,
} as NodeJS.ProcessEnv);

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

const transportOf = (fn: AppleTransport['getAllSubscriptionStatuses']): AppleTransport =>
  ({ getAllSubscriptionStatuses: fn });

describe('singleton topology tripwire', () => {
  const railway = {
    RAILWAY_SERVICE_ID: 'svc',
    RAILWAY_VOLUME_MOUNT_PATH: '/data',
    DATABASE_URL: 'file:/data/nala.db',
  } as NodeJS.ProcessEnv;

  it('accepts the volume-backed Railway topology the worker was designed for', () => {
    expect(assertSupportedSingletonTopology(railway)).toBe('railway-volume');
    expect(assertSupportedSingletonTopology({ ...railway, NODE_ENV: 'production' })).toBe('railway-volume');
  });

  it('RAILWAY PRESENCE IS AUTHORITATIVE regardless of NODE_ENV', () => {
    // A Railway service running with NODE_ENV=development is still a Railway
    // service that gains replicas the moment its volume goes away. Keying the
    // check on NODE_ENV would let exactly that deployment skip the tripwire.
    const noVolume = { RAILWAY_SERVICE_ID: 'svc', NODE_ENV: 'development', DATABASE_URL: 'postgresql://h/d' } as NodeJS.ProcessEnv;
    expect(() => assertSupportedSingletonTopology(noVolume)).toThrow(UnsupportedSingletonTopologyError);
  });

  it('is unenforced only OFF Railway and outside production', () => {
    expect(assertSupportedSingletonTopology({ NODE_ENV: 'development' } as NodeJS.ProcessEnv))
      .toBe('unenforced-non-production');
  });

  it('FAILS CLOSED when the volume is gone — Railway could then run replicas', () => {
    const { RAILWAY_VOLUME_MOUNT_PATH: _drop, ...noVolume } = railway;
    expect(() => assertSupportedSingletonTopology(noVolume as NodeJS.ProcessEnv))
      .toThrow(/may run multiple replicas/);
  });

  it('FAILS CLOSED when the database is no longer file-backed (the Postgres future)', () => {
    expect(() => assertSupportedSingletonTopology({ ...railway, DATABASE_URL: 'postgresql://host/db' }))
      .toThrow(/reachable from multiple replicas/);
  });

  it('FAILS CLOSED in production off Railway, where no platform guarantee exists', () => {
    expect(() => assertSupportedSingletonTopology({ NODE_ENV: 'production' } as NodeJS.ProcessEnv))
      .toThrow(/not on Railway/);
  });

  describe('path containment is filesystem semantics, not string prefixing', () => {
    it('accepts a database genuinely inside the volume', () => {
      expect(isPathContained('/data/nala.db', '/data')).toBe(true);
      expect(isPathContained('/data/sub/nala.db', '/data')).toBe(true);
    });

    it('REJECTS a sibling directory that merely shares the prefix', () => {
      // '/database/...' and '/data2/...' both pass a startsWith('/data') test.
      expect(isPathContained('/database/nala.db', '/data')).toBe(false);
      expect(isPathContained('/data2/nala.db', '/data')).toBe(false);
    });

    it('REJECTS traversal that starts with the mount but resolves outside', () => {
      expect(isPathContained('/data/../tmp/nala.db', '/data')).toBe(false);
    });

    it('rejects the mount itself, which is a directory not a database', () => {
      expect(isPathContained('/data', '/data')).toBe(false);
    });

    it('the tripwire refuses a non-local host outright', () => {
      expect(() => assertSupportedSingletonTopology({ ...railway, DATABASE_URL: 'file://evil-host/data/nala.db' }))
        .toThrow(/not a file: database/);
    });

    it('and the tripwire refuses each of those', () => {
      for (const url of [
        'file:/database/nala.db',
        'file:/data2/nala.db',
        'file:/data/../tmp/nala.db',
        // Percent-encoded traversal: a hand-rolled parser never decodes this and
        // sees it as inside /data. Node's parser resolves it to /tmp.
        'file:/data/%2e%2e/tmp/nala.db',
      ]) {
        expect(() => assertSupportedSingletonTopology({ ...railway, DATABASE_URL: url }), url)
          .toThrow(/does not resolve inside the mounted volume/);
      }
    });

    it('resolves the file: forms this repo actually uses', () => {
      expect(resolveFileDbPath('file:/data/nala.db')).toBe('/data/nala.db');
      expect(resolveFileDbPath('file:///data/nala.db')).toBe('/data/nala.db');
      expect(resolveFileDbPath('postgresql://h/d')).toBeNull();
      // Encoded traversal is decoded by the platform parser.
      expect(resolveFileDbPath('file:/data/%2e%2e/tmp/nala.db')).toBe('/tmp/nala.db');
      // A NON-LOCAL host is not a local path. The old hand parser stripped the
      // authority and returned /data/nala.db, treating a remote host as inside
      // the volume; the platform parser refuses it outright.
      expect(resolveFileDbPath('file://evil-host/data/nala.db')).toBeNull();
    });
  });

  it('worker id carries deployment identity AND a random boot component', () => {
    const env = { RAILWAY_DEPLOYMENT_ID: 'dep-1', RAILWAY_REPLICA_ID: 'rep-1' } as NodeJS.ProcessEnv;
    const a = buildWorkerId(env);
    expect(a).toContain('dep-1');
    expect(a).toContain('rep-1');
    // Process identity must never double as fencing identity — the #34 lesson.
    expect(a).not.toBe(buildWorkerId(env));
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
    await db.execute(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "appleAppAccountToken" TEXT, "appleOriginalTransactionId" TEXT)`);
    const sql = fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';')) { const s = stmt.trim(); if (s) await db.execute(s); }
  });
  afterEach(() => { db.close(); __resetAppleWorkerForTests(); __resetAppleRateLimitersForTests(); });

  it('processes queued work and records observability', async () => {
    await enqueue();
    const handle = __TEST_ONLY_startAppleWorker({
      env: goodEnv(), client: adapter, maxPasses: 2, idleSleepMs: 1,
      __transportFactory: () => transportOf(async ({ originalTransactionId }) => okResponse(originalTransactionId) as never),
    })!;
    await handle.done;

    expect(await subCount()).toBe(1);
    const s = getAppleWorkerStatus();
    expect(s.committedCount).toBe(1);
    expect(s.workerId).toContain('apple-worker');
    expect(s.singletonMode).toBe('unenforced-non-production');
    expect(s.currentJob).toBeNull();       // cleared once the pass ends
    expect(s.running).toBe(false);
  });

  it('OBSERVABILITY: currentJob is populated WHILE a pass is in flight', async () => {
    await enqueue();
    let seen: ReturnType<typeof getAppleWorkerStatus>['currentJob'] = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const handle = __TEST_ONLY_startAppleWorker({
      env: goodEnv(), client: adapter, maxPasses: 1, idleSleepMs: 1,
      __transportFactory: () => transportOf(async ({ originalTransactionId }) => {
        seen = getAppleWorkerStatus().currentJob;   // mid-request, as a stuck call would be
        await gate;
        return okResponse(originalTransactionId) as never;
      }),
    })!;
    await new Promise((r) => setTimeout(r, 20));
    release();
    await handle.done;

    expect(seen).not.toBeNull();
    expect(seen!.originalTransactionId).toBe(OTI);
    expect(seen!.environment).toBe('Production');
    expect(seen!.generation).toBe(1);
  });

  it('IN-PROCESS GUARD: a second start is refused, and only one loop exists', async () => {
    const opts = {
      env: goodEnv(), client: adapter, maxPasses: 3, idleSleepMs: 1,
      __transportFactory: () => transportOf(async () => { throw new Error('no work expected'); }),
    };
    const first = __TEST_ONLY_startAppleWorker(opts)!;
    expect(() => __TEST_ONLY_startAppleWorker(opts)).toThrow(AppleWorkerAlreadyRunningError);
    expect(getAppleWorkerStatus().workerId).toBe(first.workerId);
    await first.stop();
    const second = __TEST_ONLY_startAppleWorker(opts)!;      // allowed once stopped
    expect(second.workerId).not.toBe(first.workerId);
    await second.stop();
  });

  it('DISABLED: the flag is checked by the production entrypoint itself', async () => {
    await enqueue();
    let called = false;
    // Production env with NO volume: if the flag were not checked first, the
    // topology tripwire would throw instead of returning null.
    const handle = __TEST_ONLY_startAppleWorker({
      env: goodEnv({ [WORKER_ENABLED_ENV]: 'false', NODE_ENV: 'production' }),
      client: adapter,
      __transportFactory: () => transportOf(async () => { called = true; return okResponse(OTI) as never; }),
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
    expect(() => __TEST_ONLY_startAppleWorker({
      env: goodEnv({ APPLE_IAP_ISSUER_ID: '', APPLE_IAP_KEY_ID: '' }),
      client: adapter,
      __transportFactory: () => transportOf(async () => { called = true; return okResponse(OTI) as never; }),
    })).toThrow(AppleWorkerConfigError);

    try {
      __TEST_ONLY_startAppleWorker({ env: goodEnv({ APPLE_IAP_ISSUER_ID: '' }), client: adapter });
    } catch (err) {
      expect((err as AppleWorkerConfigError).missing).toEqual(['APPLE_IAP_ISSUER_ID']);
    }
    expect(called).toBe(false);
    expect(await subCount()).toBe(0);
  });

  it('CONFIG AND TRANSPORT COME FROM THE SAME SOURCE', async () => {
    // The transport is built FROM the validated config, so it is impossible to
    // pass validation for one credential set and then execute another.
    await enqueue();
    let sawConfig: { keyId: string; bundleId: string } | null = null;
    const handle = __TEST_ONLY_startAppleWorker({
      env: goodEnv({ APPLE_IAP_KEY_ID: 'the-validated-key' }), client: adapter, maxPasses: 1, idleSleepMs: 1,
      __transportFactory: (cfg) => {
        sawConfig = { keyId: cfg.auth.keyId, bundleId: cfg.auth.bundleId };
        return transportOf(async ({ originalTransactionId }) => okResponse(originalTransactionId) as never);
      },
    })!;
    await handle.done;
    expect(sawConfig).toEqual({ keyId: 'the-validated-key', bundleId: 'com.nala.portfolio' });
  });

  it('UNSUPPORTED TOPOLOGY: refuses to start even with valid config', async () => {
    expect(() => __TEST_ONLY_startAppleWorker({
      env: goodEnv({ NODE_ENV: 'production', RAILWAY_SERVICE_ID: 'svc', DATABASE_URL: 'postgresql://h/d' }),
      client: adapter,
    })).toThrow(UnsupportedSingletonTopologyError);
    expect(getAppleWorkerStatus().running).toBe(false);
  });

  it('SHUTDOWN: stop() prevents further claims but lets the current pass finish', async () => {
    await enqueue('oti-1');
    await enqueue('oti-2');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let passes = 0;
    let finishedFirst = false;

    const handle = __TEST_ONLY_startAppleWorker({
      env: goodEnv(), client: adapter, idleSleepMs: 1,
      __transportFactory: () => transportOf(async ({ originalTransactionId }) => {
        passes += 1;
        if (passes === 1) { await gate; finishedFirst = true; }
        return okResponse(originalTransactionId) as never;
      }),
    })!;

    const stopping = handle.stop();
    release();
    await stopping;

    expect(finishedFirst).toBe(true);   // in-flight pass allowed to finish
    expect(passes).toBe(1);             // and NO further job claimed
    expect(await subCount()).toBe(1);
    expect(getAppleWorkerStatus().running).toBe(false);
  });

  it('SHUTDOWN: stop() wakes an idle sleep instead of waiting it out', async () => {
    const handle = __TEST_ONLY_startAppleWorker({
      env: goodEnv(), client: adapter, idleSleepMs: 60_000,   // would hang a naive stop
      __transportFactory: () => transportOf(async () => { throw new Error('unused'); }),
    })!;
    await new Promise((r) => setTimeout(r, 20));   // let it reach the idle sleep
    const t0 = Date.now();
    await handle.stop();
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('SHUTDOWN: work interrupted mid-pass stays recoverable through the queue lease', async () => {
    await enqueue();
    const handle = __TEST_ONLY_startAppleWorker({
      env: goodEnv(), client: adapter, idleSleepMs: 1,
      __transportFactory: () => transportOf(() => new Promise(() => { /* never resolves */ })),
    })!;
    handle.stop();                       // do not await — the pass cannot complete
    await new Promise((r) => setTimeout(r, 30));

    const [row] = await rows();
    // Still claimed, with a lease that will expire and allow reclaim. NOT
    // force-released during shutdown.
    expect(String(row.reconcileState)).toBe('running');
    expect(row.leaseOwner).not.toBeNull();
    expect(row.leaseExpiresAt).not.toBeNull();
    expect(await subCount()).toBe(0);
  });

  it('installs NO signal handlers of its own — the app owns shutdown', async () => {
    const before = process.listenerCount('SIGTERM');
    const handle = __TEST_ONLY_startAppleWorker({
      env: goodEnv(), client: adapter, maxPasses: 1, idleSleepMs: 1,
      __transportFactory: () => transportOf(async () => okResponse(OTI) as never),
    })!;
    // A second SIGTERM listener would race index.ts's central shutdown, which
    // disconnects Prisma and hard-exits at 8s while an Apple call may run 15s.
    expect(process.listenerCount('SIGTERM')).toBe(before);
    await handle.stop();
  });

  it('the test-only loop runner is still guarded against duplicates', async () => {
    const opts = {
      env: goodEnv(), client: adapter, maxPasses: 1, idleSleepMs: 1,
      singletonMode: 'unenforced-non-production' as const,
      transport: transportOf(async () => okResponse(OTI) as never),
    };
    const h = __TEST_ONLY_runLoop(opts);
    expect(() => __TEST_ONLY_runLoop(opts)).toThrow(AppleWorkerAlreadyRunningError);
    await h.stop();
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
  const row = async (oti: string, environment: AppleEnvironment) => (await db.execute({
    sql: `SELECT * FROM "AppleReconciliation" WHERE "originalTransactionId"=? AND "environment"=?`,
    args: [oti, environment],
  })).rows[0] as Record<string, unknown>;

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await db.execute(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "appleAppAccountToken" TEXT, "appleOriginalTransactionId" TEXT)`);
    const sql = fs.readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';')) { const s = stmt.trim(); if (s) await db.execute(s); }
  });
  afterEach(() => db.close());

  it('the park constant is comfortably beyond the parked threshold', () => {
    expect(__PARK_EXCEEDS_THRESHOLD).toBe(true);
    expect(PERMANENT_PARK_MS).toBeGreaterThan(PARKED_THRESHOLD_MS);
  });

  it('requeues ONLY parked rows, never rows merely backing off or running', async () => {
    await seed('parked', 'Production', PERMANENT_PARK_MS);
    await seed('backing-off', 'Production', 30 * 60_000);
    await seed('running-job', 'Production', PERMANENT_PARK_MS, 'running');

    expect(await requeueParkedAppleReconciliations({ environment: 'Production' }, { client: adapter })).toBe(1);

    const parked = await row('parked', 'Production');
    expect(String(parked.reconcileState)).toBe('pending');
    expect(Number(parked.attemptCount)).toBe(0);
    expect(parked.lastError).toBeNull();
    expect(parked.leaseOwner).toBeNull();

    expect(String((await row('backing-off', 'Production')).reconcileState)).toBe('failed');
    expect(String((await row('running-job', 'Production')).reconcileState)).toBe('running');
  });

  it('COMPOSITE IDENTITY: an originalTransactionId alone is refused', async () => {
    // The same id exists independently in both environments; the schema enforces
    // (environment, originalTransactionId). The recovery tool must not adopt a
    // weaker identity rule than the system it repairs.
    await seed(OTI, 'Production', PERMANENT_PARK_MS);
    await seed(OTI, 'Sandbox', PERMANENT_PARK_MS);

    await expect(requeueParkedAppleReconciliations({ originalTransactionId: OTI }, { client: adapter }))
      .rejects.toBeInstanceOf(RequeueScopeError);
    expect(String((await row(OTI, 'Production')).reconcileState)).toBe('failed');
    expect(String((await row(OTI, 'Sandbox')).reconcileState)).toBe('failed');

    // Scoped to one environment: only that row wakes.
    expect(await requeueParkedAppleReconciliations(
      { environment: 'Production', originalTransactionId: OTI }, { client: adapter })).toBe(1);
    expect(String((await row(OTI, 'Production')).reconcileState)).toBe('pending');
    expect(String((await row(OTI, 'Sandbox')).reconcileState)).toBe('failed');
  });

  it('COMPOSITE IDENTITY: --both-environments makes it deliberate', async () => {
    await seed(OTI, 'Production', PERMANENT_PARK_MS);
    await seed(OTI, 'Sandbox', PERMANENT_PARK_MS);
    expect(await requeueParkedAppleReconciliations(
      { originalTransactionId: OTI, bothEnvironments: true }, { client: adapter })).toBe(2);
    expect(String((await row(OTI, 'Production')).reconcileState)).toBe('pending');
    expect(String((await row(OTI, 'Sandbox')).reconcileState)).toBe('pending');
  });

  it('scope rules are enforced identically wherever they are checked', () => {
    expect(() => assertRequeueScope({ environment: 'Production' })).not.toThrow();
    expect(() => assertRequeueScope({ environment: 'Production', originalTransactionId: OTI })).not.toThrow();
    expect(() => assertRequeueScope({ all: true })).not.toThrow();
    expect(() => assertRequeueScope({ originalTransactionId: OTI, bothEnvironments: true })).not.toThrow();
    expect(() => assertRequeueScope({ originalTransactionId: OTI })).toThrow(/BOTH environments/);
    expect(() => assertRequeueScope({})).toThrow(/without an explicit --all/);
  });

  it('REFUSES an unscoped mass requeue without an explicit --all', async () => {
    await seed('p1', 'Production', PERMANENT_PARK_MS);
    await expect(requeueParkedAppleReconciliations({}, { client: adapter }))
      .rejects.toBeInstanceOf(RequeueScopeError);
    expect(String((await row('p1', 'Production')).reconcileState)).toBe('failed');

    expect(await requeueParkedAppleReconciliations({ all: true }, { client: adapter })).toBe(1);
    expect(String((await row('p1', 'Production')).reconcileState)).toBe('pending');
  });

  it('counts parked rows for before/after reporting', async () => {
    await seed('p1', 'Production', PERMANENT_PARK_MS);
    await seed('p2', 'Production', PERMANENT_PARK_MS);
    await seed('b1', 'Production', 60_000);
    expect(await countParkedAppleReconciliations({}, { client: adapter })).toBe(2);
    expect(await countParkedAppleReconciliations({ environment: 'Sandbox' }, { client: adapter })).toBe(0);
  });
});

describe('production entrypoint is structurally unbypassable', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    __resetAppleWorkerForTests();
  });

  it('accepts NO arguments, so nothing can be injected at the call site', () => {
    // Arity alone is not enough — a default parameter would still report 0 — so
    // this also proves an injected environment is IGNORED. The real process.env
    // has no enable flag here, so a worker that honoured the argument would try
    // to start instead of returning null.
    expect(startAppleWorker.length).toBe(0);
    delete process.env[WORKER_ENABLED_ENV];
    const injected = (startAppleWorker as unknown as (o: unknown) => unknown)({
      env: goodEnv(), client: undefined, maxPasses: 1,
      __transportFactory: () => transportOf(async () => { throw new Error('must not run'); }),
    });
    expect(injected).toBeNull();
    expect(getAppleWorkerStatus().enabled).toBe(false);
  });

  it('reads the REAL process.env for the enable flag', () => {
    delete process.env[WORKER_ENABLED_ENV];
    expect(startAppleWorker()).toBeNull();
    expect(getAppleWorkerStatus().enabled).toBe(false);
  });

  it('derives its configuration from the REAL process.env, not a caller', () => {
    process.env[WORKER_ENABLED_ENV] = 'true';
    delete process.env.APPLE_IAP_ISSUER_ID;
    delete process.env.APPLE_IAP_KEY_ID;
    delete process.env.APPLE_IAP_PRIVATE_KEY;
    // Reaching the config gate at all proves the flag came from process.env; the
    // missing names prove the config did too.
    try {
      startAppleWorker();
      throw new Error('expected a config error');
    } catch (err) {
      expect(err).toBeInstanceOf(AppleWorkerConfigError);
      expect((err as AppleWorkerConfigError).missing).toContain('APPLE_IAP_ISSUER_ID');
    }
  });

  it('the injectable surface refuses to run outside a test process', () => {
    const vitest = process.env.VITEST;
    const nodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => __TEST_ONLY_startAppleWorker({ env: { [WORKER_ENABLED_ENV]: 'false' } as NodeJS.ProcessEnv }))
        .toThrow(/test-only entrypoint/);
    } finally {
      if (vitest === undefined) delete process.env.VITEST; else process.env.VITEST = vitest;
      if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
    }
  });
});
