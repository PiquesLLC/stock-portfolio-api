import * as fs from 'fs';
import { Request, Response } from 'express';
import { config } from '../config';
import { getFinnhubStatus } from '../utils/finnhub';
import { getPolygonStatus } from '../utils/polygon';
import { getYahooStatus } from '../utils/yahoo-http';
import { getAuthMetrics } from '../utils/auth-metrics';
import { getWebhookMetrics } from '../utils/webhook-metrics';
import { getProviderMetrics } from '../utils/provider-metrics';
import prisma from '../utils/prisma';
import { getJobRunnerMetrics, getActiveBackgroundJobCount, isDbBrownout } from '../services/job-runner.service';
import { getWalWatchdogState } from '../services/db-watchdog.service';
import { getLastBackupStatus } from '../services/backup.service';
import { getAppleWorkerStatus } from '../services/apple-reconciliation-worker';

export async function healthCheck(_req: Request, res: Response): Promise<void> {
  const response: {
    status: 'ok';
    disk?: {
      totalMB: number;
      freeMB: number;
      usedPercent: number;
    };
  } = { status: 'ok' };

  if (fs.existsSync('/data')) {
    const stats = fs.statfsSync('/data');
    const totalMB = Math.round((stats.bsize * stats.blocks) / 1024 / 1024);
    const freeMB = Math.round((stats.bsize * stats.bavail) / 1024 / 1024);
    const usedPercent = Math.round(((totalMB - freeMB) / totalMB) * 100);
    response.disk = { totalMB, freeMB, usedPercent };
  }

  res.json(response);
}

// Race a promise against a deadline. The loser keeps running (a stuck DB
// write can't be cancelled) but the health response must return promptly.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`probe timeout after ${ms}ms`)), ms);
      t.unref();
    }),
  ]);
}

const PROBE_TIMEOUT_MS = 3000;

/**
 * Deep health: exercises a real DB read AND a real DB write (single-row
 * upsert into HealthProbe, bootstrapped at startup) with a short deadline.
 * 503 when the write path is down — that is exactly the state of the
 * 2026-07-14 outage, which the shallow /health could not see. Also surfaces
 * WAL-watchdog and job-runner brownout state for one-glance diagnosis.
 */
export async function healthDeep(_req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  let readOk = false;
  let readMs = -1;
  let writeOk = false;
  let writeMs = -1;
  let error: string | undefined;

  try {
    const t0 = Date.now();
    await withTimeout(prisma.$queryRawUnsafe('SELECT 1'), PROBE_TIMEOUT_MS);
    readMs = Date.now() - t0;
    readOk = true;
  } catch (e) {
    error = `read: ${(e as Error).message}`;
  }

  if (readOk) {
    try {
      const t0 = Date.now();
      await withTimeout(
        prisma.$executeRawUnsafe(
          `INSERT INTO "HealthProbe" ("id", "ts") VALUES (1, '${new Date().toISOString()}')
           ON CONFLICT("id") DO UPDATE SET "ts" = excluded."ts"`,
        ),
        PROBE_TIMEOUT_MS,
      );
      writeMs = Date.now() - t0;
      writeOk = true;
    } catch (e) {
      error = `write: ${(e as Error).message}`;
    }
  }

  const wal = getWalWatchdogState();
  const healthy = readOk && writeOk;
  const body: Record<string, unknown> = {
    status: healthy ? 'ok' : 'degraded',
    db: { readOk, readMs, writeOk, writeMs, brownout: isDbBrownout() },
    wal: { bytes: wal.walBytes, lastCheckAt: wal.lastCheckAt, lastCheckpoint: wal.lastCheckpoint },
    lastBackup: getLastBackupStatus(),
    uptimeSec: Math.round(process.uptime()),
    commit: (process.env.RAILWAY_GIT_COMMIT_SHA || 'local').slice(0, 7),
    totalMs: Date.now() - startedAt,
  };
  if (error) body.error = error;

  // Apple reconciliation worker, surfaced through the EXISTING deep-health
  // endpoint rather than a new admin route: an operator asking whether
  // reconciliation is running should not need a second place to look.
  //
  // THIS ROUTE IS PUBLIC. It carries no auth and is listed in
  // ORIGIN_LOCKDOWN_EXEMPT_PATHS so the platform healthcheck can reach it, so
  // nothing customer-identifying may appear here. In particular:
  //
  //   currentJob  carries a live originalTransactionId — an internal billing
  //               identifier for a real subscriber. Only a boolean is exposed.
  //   workerId    embeds deployment/replica ids and a boot uuid; it is internal
  //               topology detail with no operational value to the public.
  //
  // If the exact in-flight subscription is ever needed for debugging, it belongs
  // behind the existing admin-authenticated diagnostics, not here.
  const appleWorker = getAppleWorkerStatus();
  body.appleWorker = {
    enabled: appleWorker.enabled,
    running: appleWorker.running,
    stopping: appleWorker.stopping,
    singletonMode: appleWorker.singletonMode,
    startedAt: appleWorker.startedAt,
    lastLoopAt: appleWorker.lastLoopAt,
    lastOutcome: appleWorker.lastOutcome,
    hasCurrentJob: appleWorker.currentJob !== null,
    counts: {
      processed: appleWorker.processedCount,
      committed: appleWorker.committedCount,
      stale: appleWorker.staleCount,
      failed: appleWorker.failedCount,
      rateLimited: appleWorker.rateLimitedCount,
      parked: appleWorker.parkedCount,
      deferred: appleWorker.deferredCount,
      idle: appleWorker.idleCount,
    },
  };

  if (fs.existsSync('/data')) {
    const stats = fs.statfsSync('/data');
    const totalMB = Math.round((stats.bsize * stats.blocks) / 1024 / 1024);
    const freeMB = Math.round((stats.bsize * stats.bavail) / 1024 / 1024);
    body.disk = { totalMB, freeMB, usedPercent: Math.round(((totalMB - freeMB) / totalMB) * 100) };
  }

  res.status(healthy ? 200 : 503).json(body);
}

export async function authMetrics(req: Request, res: Response): Promise<void> {
  res.json({
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ...getAuthMetrics(),
  });
}

export async function apiUsage(req: Request, res: Response): Promise<void> {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const logs = await prisma.apiUsageLog.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      // Only the columns the aggregation below reads — the table grows on every
      // AI call, so a 90-day scan of full rows is needless memory pressure.
      select: { feature: true, inputTokens: true, outputTokens: true, costUsdEstimate: true, createdAt: true },
    });

  // Totals
  let totalCalls = logs.length;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;

  // By feature
  const byFeature = new Map<string, { calls: number; inputTokens: number; outputTokens: number; cost: number }>();
  // By day
  const byDay = new Map<string, { calls: number; inputTokens: number; outputTokens: number; cost: number }>();

  for (const log of logs) {
    totalInputTokens += log.inputTokens;
    totalOutputTokens += log.outputTokens;
    totalCost += log.costUsdEstimate;

    // By feature
    const feat = byFeature.get(log.feature) ?? { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    feat.calls++;
    feat.inputTokens += log.inputTokens;
    feat.outputTokens += log.outputTokens;
    feat.cost += log.costUsdEstimate;
    byFeature.set(log.feature, feat);

    // By day
    const dayKey = log.createdAt.toISOString().slice(0, 10);
    const day = byDay.get(dayKey) ?? { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    day.calls++;
    day.inputTokens += log.inputTokens;
    day.outputTokens += log.outputTokens;
    day.cost += log.costUsdEstimate;
    byDay.set(dayKey, day);
  }

  const round4 = (n: number) => Math.round(n * 10000) / 10000;

  res.json({
    period: { days, since: since.toISOString() },
    totals: {
      calls: totalCalls,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: round4(totalCost),
    },
    byFeature: Object.fromEntries(
      [...byFeature.entries()]
        .sort((a, b) => b[1].cost - a[1].cost)
        .map(([k, v]) => [k, { ...v, cost: round4(v.cost) }])
    ),
    byDay: Object.fromEntries(
      [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => [k, { ...v, cost: round4(v.cost) }])
    ),
  });
  } catch (error: unknown) {
    // Express 4 doesn't catch async throws — without this, a DB rejection
    // hangs the request to a 504 instead of returning 500.
    console.error('[Health] apiUsage error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to load API usage' });
  }
}

export async function webhookMetrics(req: Request, res: Response): Promise<void> {
  res.json(getWebhookMetrics());
}

export async function providerMetrics(req: Request, res: Response): Promise<void> {
  res.json(getProviderMetrics());
}

export async function jobMetrics(req: Request, res: Response): Promise<void> {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 168);
    const metrics = await getJobRunnerMetrics(hours);
    res.json(metrics);
  } catch (error: unknown) {
    // Express 4 doesn't catch async throws — without this, a DB rejection
    // hangs the request to a 504 instead of returning 500.
    console.error('[Health] jobMetrics error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to load job metrics' });
  }
}

export async function healthStatus(req: Request, res: Response): Promise<void> {
  // DB latency
  const dbStartedAt = Date.now();
  let database: { connected: boolean; latencyMs: number | null; error?: string } = {
    connected: false,
    latencyMs: null,
  };
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = { connected: true, latencyMs: Date.now() - dbStartedAt };
  } catch (error: unknown) {
    console.error('[Health] DB status check failed:', error instanceof Error ? error.message : String(error));
    database = {
      connected: false,
      latencyMs: Date.now() - dbStartedAt,
      error: 'unavailable',
    };
  }

  let lastSnapshot: { timestamp: Date } | null = null;
  try {
    lastSnapshot = await prisma.portfolioSnapshot.findFirst({
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    });
  } catch {
    // Table may not exist in test/CI environments
  }
  const memoryUsage = process.memoryUsage();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database,
    snapshots: {
      lastSuccessfulSnapshotAt: lastSnapshot?.timestamp?.toISOString() ?? null,
    },
    backgroundJobs: {
      activeCount: getActiveBackgroundJobCount(),
    },
    memory: {
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
      arrayBuffers: memoryUsage.arrayBuffers,
    },
    providers: {
      finnhub: {
        configured: Boolean(config.finnhubApiKey),
        ...getFinnhubStatus(),
      },
      polygon: {
        configured: Boolean(config.polygonApiKey),
        ...getPolygonStatus(),
      },
      yahoo: {
        configured: true,
        ...getYahooStatus(),
      },
    },
  });
}
