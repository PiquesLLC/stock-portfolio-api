/**
 * Singleton-topology tripwire for the Apple reconciliation worker.
 *
 * WHY THERE IS NO DATABASE WORKER LEASE
 *
 * A lease only coordinates contenders that can reach the same database. Railway
 * does not permit replicas on a service with an attached volume, and the
 * authoritative SQLite database lives on that volume — so a second worker
 * sharing this database cannot exist in the current topology. A lease table
 * would add schema, a migration (into unresolved migration-history drift) and
 * ceremony while protecting a failure mode the platform already prevents.
 *
 * The enforcement is therefore three layers:
 *
 *   1. Railway + volume   cross-process: the platform disallows replicas.
 *   2. In-process guard   startAppleReconciliationWorker refuses a second loop.
 *   3. This tripwire      fails CLOSED if layer 1 ever stops being true.
 *
 * Layer 3 is the point of this file. The day the primary database moves to
 * Postgres, or the volume is detached, Railway replicas become possible again —
 * and N replicas would each hold a full 50/s Production budget, silently
 * multiplying the request rate the limiter exists to bound. That must become a
 * BOOT FAILURE demanding a distributed worker lease, not an unnoticed
 * regression.
 */

export type SingletonMode = 'railway-volume' | 'unenforced-non-production';

export class UnsupportedSingletonTopologyError extends Error {
  constructor(readonly detail: string) {
    super(
      `Apple reconciliation worker refuses to start: ${detail}. ` +
      'The worker relies on Railway\'s volume-backed single-replica guarantee as its ' +
      'only singleton mechanism. If that guarantee no longer holds, implement a ' +
      'distributed worker lease (renewable, fencing token, expiry) before enabling it.',
    );
    this.name = 'UnsupportedSingletonTopologyError';
  }
}

/**
 * Assert the deployment still matches the topology the worker was designed for.
 *
 * Outside production this returns `unenforced-non-production`: a developer
 * running one process locally is not the failure mode being guarded, and
 * demanding Railway variables would make the worker untestable.
 */
export function assertSupportedSingletonTopology(
  env: NodeJS.ProcessEnv = process.env,
): SingletonMode {
  if (env.NODE_ENV !== 'production') return 'unenforced-non-production';

  // On Railway? Without the platform guarantee there is nothing enforcing one
  // worker, and we must not assume a bare process is alone.
  if (!env.RAILWAY_SERVICE_ID) {
    throw new UnsupportedSingletonTopologyError(
      'running in production but not on Railway, so no platform singleton guarantee applies',
    );
  }

  // A volume is what makes replicas impossible. No volume, no guarantee.
  const mountPath = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!mountPath) {
    throw new UnsupportedSingletonTopologyError(
      'no RAILWAY_VOLUME_MOUNT_PATH is attached, so Railway may run multiple replicas',
    );
  }

  /**
   * The database must actually live on that volume. A network database is
   * reachable from every replica, which is precisely the situation the volume
   * restriction stops being able to prevent — and the likely shape of a future
   * Postgres migration.
   */
  const url = env.DATABASE_URL ?? '';
  if (!url.startsWith('file:')) {
    throw new UnsupportedSingletonTopologyError(
      'DATABASE_URL is not a file: database, so it is reachable from multiple replicas',
    );
  }
  const dbPath = url.slice('file:'.length);
  if (!dbPath.startsWith(mountPath)) {
    throw new UnsupportedSingletonTopologyError(
      'DATABASE_URL does not live under the mounted volume, so the volume does not bound access to it',
    );
  }

  return 'railway-volume';
}

/**
 * Worker identity for logs and diagnostics.
 *
 * The random boot component is deliberate: process identity must never double as
 * fencing identity. That was the #34 lesson — a reused worker name let stale work
 * satisfy a lease check it should have failed. Nothing here is used for fencing,
 * and the random suffix keeps it that way even if someone later reaches for it.
 */
export function buildWorkerId(env: NodeJS.ProcessEnv = process.env): string {
  return [
    'apple-worker',
    env.RAILWAY_DEPLOYMENT_ID ?? 'local',
    env.RAILWAY_REPLICA_ID ?? 'norep',
    String(process.pid),
    globalThis.crypto.randomUUID(),
  ].join(':');
}
