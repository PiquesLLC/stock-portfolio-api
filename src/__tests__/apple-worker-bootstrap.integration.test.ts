import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  stopAppleWorkerThenDisconnect,
  APPLE_WORKER_STOP_BUDGET_MS,
} from '../services/apple-worker-lifecycle';
import {
  startAppleWorker,
  getAppleWorkerStatus,
  __resetAppleWorkerForTests,
  AppleWorkerConfigError,
  WORKER_ENABLED_ENV,
  type AppleWorkerHandle,
} from '../services/apple-reconciliation-worker';
import { UnsupportedSingletonTopologyError } from '../services/apple-worker-topology';

/**
 * Bootstrap and shutdown integration.
 *
 * The ordering requirement is the point of this file: the Apple worker must stop
 * BEFORE Prisma disconnects, because the in-flight reconciliation pass still
 * needs the database. That is exercised as real sequencing — a fake disconnect
 * records when it ran relative to the worker stopping — rather than asserted in
 * a comment.
 */

const IDX = path.join(__dirname, '..', 'index.ts');
const RAILWAY_JSON = path.join(__dirname, '..', '..', 'railway.json');

/** A worker handle whose stop() we can observe and control. */
function fakeWorker(over: { stopDelayMs?: number; onStop?: () => void } = {}): AppleWorkerHandle {
  return {
    workerId: 'fake-worker',
    singletonMode: 'unenforced-non-production',
    done: Promise.resolve(),
    stop: async () => {
      if (over.stopDelayMs) await new Promise((r) => setTimeout(r, over.stopDelayMs));
      over.onStop?.();
    },
  };
}

describe('shutdown ordering: worker stops before Prisma disconnects', () => {
  it('stops the worker, THEN disconnects', async () => {
    const order: string[] = [];
    const worker = fakeWorker({ stopDelayMs: 20, onStop: () => order.push('worker-stopped') });
    const outcome = await stopAppleWorkerThenDisconnect(
      worker,
      async () => { order.push('prisma-disconnected'); },
    );
    expect(order).toEqual(['worker-stopped', 'prisma-disconnected']);
    expect(outcome).toBe('stopped');
  });

  it('waits for an IN-FLIGHT pass rather than disconnecting underneath it', async () => {
    // The pass takes real time; disconnect must not begin until it is done.
    let passFinished = false;
    let disconnectedBeforePass = false;
    const worker = fakeWorker({ stopDelayMs: 50, onStop: () => { passFinished = true; } });
    await stopAppleWorkerThenDisconnect(worker, async () => {
      if (!passFinished) disconnectedBeforePass = true;
    });
    expect(passFinished).toBe(true);
    expect(disconnectedBeforePass).toBe(false);
  });

  it('still disconnects when there is NO worker', async () => {
    let disconnected = false;
    const outcome = await stopAppleWorkerThenDisconnect(null, async () => { disconnected = true; });
    expect(outcome).toBe('no-worker');
    expect(disconnected).toBe(true);
  });

  it('a hung pass cannot gate teardown, and is NOT force-released', async () => {
    // Budget exceeded: shutdown proceeds. The reconciliation lease is left alone,
    // so the already-reviewed lease-expiry path is what recovers the row.
    let disconnected = false;
    const hung: AppleWorkerHandle = {
      workerId: 'hung', singletonMode: 'unenforced-non-production',
      done: new Promise(() => { /* never */ }),
      stop: () => new Promise(() => { /* never resolves */ }),
    };
    const outcome = await stopAppleWorkerThenDisconnect(
      hung, async () => { disconnected = true; }, { budgetMs: 30 },
    );
    expect(outcome).toBe('budget-exceeded');
    expect(disconnected).toBe(true);
  });

  it('a failing stop() does not prevent disconnect', async () => {
    let disconnected = false;
    const bad: AppleWorkerHandle = {
      workerId: 'bad', singletonMode: 'unenforced-non-production', done: Promise.resolve(),
      stop: async () => { throw new Error('stop blew up'); },
    };
    await stopAppleWorkerThenDisconnect(bad, async () => { disconnected = true; });
    expect(disconnected).toBe(true);
  });

  it('the stop budget sits above Apple\'s transport timeout and below the hard deadline', () => {
    const idx = fs.readFileSync(IDX, 'utf8');
    const deadline = Number(/SHUTDOWN_HARD_DEADLINE_MS = ([\d_]+)/.exec(idx)?.[1].replace(/_/g, ''));
    expect(APPLE_WORKER_STOP_BUDGET_MS).toBeGreaterThan(15_000);   // Apple request timeout
    expect(deadline).toBeGreaterThan(APPLE_WORKER_STOP_BUDGET_MS);
    expect(deadline).toBeGreaterThanOrEqual(25_000);
  });

  it('Railway draining exceeds the app hard deadline, so the deadline is real', () => {
    // Railway's documented default draining is 0s. Without this setting the
    // platform would SIGKILL long before a 30s deadline fires, making the extra
    // shutdown budget fiction.
    const rj = JSON.parse(fs.readFileSync(RAILWAY_JSON, 'utf8'));
    const draining = rj.deploy?.drainingSeconds;
    const idx = fs.readFileSync(IDX, 'utf8');
    const deadlineMs = Number(/SHUTDOWN_HARD_DEADLINE_MS = ([\d_]+)/.exec(idx)?.[1].replace(/_/g, ''));
    expect(typeof draining).toBe('number');
    expect(draining * 1000).toBeGreaterThan(deadlineMs);
  });
});

describe('index.ts wiring', () => {
  const idx = fs.readFileSync(IDX, 'utf8');

  it('calls the argumentless production entrypoint, with no alternate construction path', () => {
    expect(idx).toContain('appleWorker = startAppleWorker();');
    // No injectable entrypoint, and no hand-rolled transport/worker construction.
    expect(idx).not.toContain('__TEST_ONLY_startAppleWorker');
    expect(idx).not.toContain('__TEST_ONLY_runLoop');
    expect(idx).not.toContain('createProductionAppleTransport');
  });

  it('retains the handle on the application lifecycle', () => {
    expect(idx).toMatch(/let appleWorker: AppleWorkerHandle \| null = null;/);
  });

  it('routes shutdown through the ordered stop-then-disconnect unit', () => {
    expect(idx).toContain('stopAppleWorkerThenDisconnect(');
    // The raw disconnect must not also be called separately for the Apple path.
    const disconnects = idx.split('prisma.$disconnect()').length - 1;
    expect(disconnects).toBe(1);
  });

  it('installs NO Apple-owned signal listener', () => {
    expect(idx).not.toContain('installAppleWorkerSignalHandlers');
    // The app's own SIGTERM/SIGINT handlers remain the only ones.
    expect(idx).toContain("process.on('SIGTERM'");
  });

  it('fails the boot loudly when an ENABLED worker cannot start', () => {
    expect(idx).toContain('[FATAL]');
    expect(idx).toContain('process.exit(1)');
    // The fatal path must be attached to the worker start, not somewhere else.
    const start = idx.indexOf('appleWorker = startAppleWorker();');
    const fatal = idx.indexOf('[FATAL] critical startup failed, refusing to listen');
    expect(start).toBeGreaterThan(-1);
    expect(fatal).toBeGreaterThan(start);
  });

  it('starts the worker BEFORE the server begins listening', () => {
    const start = idx.indexOf('appleWorker = startAppleWorker();');
    const listen = idx.indexOf('server = app.listen(');
    expect(start).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(start);
  });
});

describe('boot behaviour of the production entrypoint', () => {
  const saved = { ...process.env };
  beforeEach(() => __resetAppleWorkerForTests());
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    __resetAppleWorkerForTests();
  });

  it('DISABLED boot is completely inert: no credentials, no worker, no claims', () => {
    process.env[WORKER_ENABLED_ENV] = 'false';
    delete process.env.APPLE_IAP_ISSUER_ID;
    delete process.env.APPLE_IAP_KEY_ID;
    delete process.env.APPLE_IAP_PRIVATE_KEY;
    delete process.env.APPLE_BUNDLE_ID;
    delete process.env.APPLE_APP_APPLE_ID;

    expect(startAppleWorker()).toBeNull();
    const s = getAppleWorkerStatus();
    expect(s.enabled).toBe(false);
    expect(s.running).toBe(false);
    expect(s.workerId).toBeNull();
  });

  it('ENABLED with missing credentials fails closed before claiming anything', () => {
    process.env[WORKER_ENABLED_ENV] = 'true';
    delete process.env.APPLE_IAP_ISSUER_ID;
    expect(() => startAppleWorker()).toThrow(AppleWorkerConfigError);
    expect(getAppleWorkerStatus().running).toBe(false);
  });

  it('ENABLED with an unsupported singleton topology fails closed', () => {
    process.env[WORKER_ENABLED_ENV] = 'true';
    process.env.NODE_ENV = 'production';
    process.env.RAILWAY_SERVICE_ID = 'svc';
    process.env.DATABASE_URL = 'postgresql://host/db';   // no volume bound
    expect(() => startAppleWorker()).toThrow(UnsupportedSingletonTopologyError);
    expect(getAppleWorkerStatus().running).toBe(false);
  });

  it('a failed start leaves the process NOT pretending reconciliation is running', () => {
    process.env[WORKER_ENABLED_ENV] = 'true';
    delete process.env.APPLE_IAP_KEY_ID;
    try { startAppleWorker(); } catch { /* expected */ }
    const s = getAppleWorkerStatus();
    expect(s.running).toBe(false);
    expect(s.workerId).toBeNull();
    // index.ts turns this into process.exit(1); the state must not claim health.
    expect(s.lastLoopAt).toBeNull();
  });
});

describe('startup ordering: SQLite pragmas before the worker, both before listen', () => {
  const idx = fs.readFileSync(IDX, 'utf8');

  it('runs initSqlitePragmas BEFORE starting the worker', () => {
    // The worker can claim a reconciliation job immediately, and that is database
    // work. Starting it before busy_timeout and WAL are established exposes it to
    // exactly the SQLITE_BUSY class this codebase has spent a long time on.
    const pragmas = idx.indexOf('await initSqlitePragmas();');
    const worker = idx.indexOf('appleWorker = startAppleWorker();');
    expect(pragmas).toBeGreaterThan(-1);
    expect(worker).toBeGreaterThan(-1);
    expect(pragmas).toBeLessThan(worker);
  });

  it('starts listening only AFTER both have completed', () => {
    const worker = idx.indexOf('appleWorker = startAppleWorker();');
    const listen = idx.indexOf('server = app.listen(');
    expect(listen).toBeGreaterThan(worker);
  });

  it('the pragma call is not left behind inside the listen callback', () => {
    // Two call sites would make the ordering ambiguous again.
    expect(idx.split('await initSqlitePragmas();').length - 1).toBe(1);
  });

  it('both steps sit inside one fail-closed bootstrap', () => {
    expect(idx).toContain('async function startCriticalServices()');
    expect(idx).toContain('await startCriticalServices();');
    const boot = idx.indexOf('await startCriticalServices();');
    const fatal = idx.indexOf('[FATAL] critical startup failed, refusing to listen');
    const listen = idx.indexOf('server = app.listen(');
    expect(fatal).toBeGreaterThan(boot);
    expect(listen).toBeGreaterThan(fatal);   // the fatal path precedes listening
    expect(idx).toContain('process.exit(1);');
  });

  it('shutdown tolerates SIGTERM arriving before the server ever listened', () => {
    expect(idx).toContain('server never listened');
    expect(idx).toMatch(/let server: import\('http'\)\.Server \| undefined;/);
  });
});

describe('public /health/deep must not leak subscriber identifiers', () => {
  const health = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'health.controller.ts'), 'utf8',
  );
  const block = health.slice(
    health.indexOf('body.appleWorker = {'),
    health.indexOf('body.appleWorker = {') + 900,
  );

  it('does NOT expose currentJob, which carries a live originalTransactionId', () => {
    // /health/deep is unauthenticated and is listed in ORIGIN_LOCKDOWN_EXEMPT_PATHS,
    // so anything here is world-readable. currentJob names a real subscriber.
    expect(block).not.toContain('currentJob: appleWorker.currentJob');
    expect(block).not.toContain('originalTransactionId');
  });

  it('does NOT expose workerId, which embeds deployment and replica identity', () => {
    expect(block).not.toContain('workerId: appleWorker.workerId');
  });

  it('DOES expose a boolean so operators can still see work in flight', () => {
    expect(block).toContain('hasCurrentJob: appleWorker.currentJob !== null');
  });

  it('keeps the aggregate operational state that is safe to publish', () => {
    for (const field of ['enabled', 'running', 'stopping', 'singletonMode', 'lastOutcome', 'counts']) {
      expect(block, field).toContain(field);
    }
  });

  it('the route really is public, which is why this matters', () => {
    const appTs = fs.readFileSync(path.join(__dirname, '..', 'app.ts'), 'utf8');
    expect(appTs).toContain("'/health/deep'");
    const exempt = appTs.slice(
      appTs.indexOf('ORIGIN_LOCKDOWN_EXEMPT_PATHS'),
      appTs.indexOf('ORIGIN_LOCKDOWN_EXEMPT_PATHS') + 400,
    );
    expect(exempt).toContain('/health/deep');
  });
});
