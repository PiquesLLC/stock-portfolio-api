import path from 'path';

/**
 * Singleton-topology tripwire for the Apple reconciliation worker.
 *
 * WHY THERE IS NO DATABASE WORKER LEASE
 *
 * A lease only coordinates contenders that can reach the same database. Railway
 * does not permit replicas on a service with an attached volume, and the
 * authoritative SQLite database lives on that volume — so a second worker
 * sharing this database cannot exist in the current topology. A lease table
 * would add schema and a migration (into unresolved migration-history drift)
 * while protecting a failure mode the platform already prevents.
 *
 * Enforcement is three layers:
 *
 *   1. Railway + volume   cross-process: the platform disallows replicas.
 *   2. In-process guard   the worker refuses a second loop.
 *   3. This tripwire      fails CLOSED if layer 1 ever stops being true.
 *
 * Layer 3 is the point. The day the primary database moves to Postgres, or the
 * volume is detached, replicas become possible again — and N replicas would each
 * hold a full 50/s Production budget, silently multiplying the request rate the
 * limiter exists to bound. That must become a BOOT FAILURE demanding a
 * distributed worker lease.
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
 * Resolve a `file:` DATABASE_URL to a filesystem path.
 *
 * The repo's production form is `file:/data/nala.db` (no authority), which
 * `fileURLToPath` rejects, so the scheme is stripped and the remainder resolved.
 * POSIX semantics are used deliberately: the deployment is Linux, and using the
 * host's path rules would make this behave differently on a Windows dev machine
 * than in the environment it is protecting.
 */
export function resolveFileDbPath(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith('file:')) return null;
  let raw = databaseUrl.slice('file:'.length);
  // file://host/path and file:///path both collapse to the path component.
  if (raw.startsWith('//')) raw = raw.replace(/^\/\/[^/]*/, '');
  return path.posix.resolve(raw.split('?')[0]);
}

/**
 * True only when `dbPath` is genuinely INSIDE `mountPath`.
 *
 * String prefixing is not containment: with a mount of `/data`, `/database/x.db`
 * shares the prefix without being inside it, and `/data/../tmp/x.db` starts with
 * it while resolving outside. Both would have passed a startsWith test.
 */
export function isPathContained(dbPath: string, mountPath: string): boolean {
  const mount = path.posix.resolve(mountPath);
  const target = path.posix.resolve(dbPath);
  const rel = path.posix.relative(mount, target);
  return rel !== '' && !rel.startsWith('..') && !path.posix.isAbsolute(rel);
}

/**
 * Assert the deployment still matches the topology the worker was designed for.
 *
 * RAILWAY PRESENCE IS AUTHORITATIVE, regardless of NODE_ENV. A Railway service
 * running with NODE_ENV unset or 'development' is still a Railway service that
 * can gain replicas the moment its volume goes away; keying the check on
 * NODE_ENV would let exactly that deployment skip the tripwire.
 *
 * Off Railway, production still fails closed — nothing there enforces one
 * worker. Non-production off Railway is unenforced, because one developer
 * running one process is not the failure mode being guarded and demanding
 * Railway variables would make the worker untestable.
 */
export function assertSupportedSingletonTopology(
  env: NodeJS.ProcessEnv = process.env,
): SingletonMode {
  const onRailway = Boolean(env.RAILWAY_SERVICE_ID);

  if (!onRailway) {
    if (env.NODE_ENV === 'production') {
      throw new UnsupportedSingletonTopologyError(
        'running in production but not on Railway, so no platform singleton guarantee applies',
      );
    }
    return 'unenforced-non-production';
  }

  // On Railway: the volume is what makes replicas impossible.
  const mountPath = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!mountPath) {
    throw new UnsupportedSingletonTopologyError(
      'no RAILWAY_VOLUME_MOUNT_PATH is attached, so Railway may run multiple replicas',
    );
  }

  const url = env.DATABASE_URL ?? '';
  const dbPath = resolveFileDbPath(url);
  if (!dbPath) {
    throw new UnsupportedSingletonTopologyError(
      'DATABASE_URL is not a file: database, so it is reachable from multiple replicas',
    );
  }
  if (!isPathContained(dbPath, mountPath)) {
    throw new UnsupportedSingletonTopologyError(
      'DATABASE_URL does not resolve inside the mounted volume, so the volume does not bound access to it',
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
