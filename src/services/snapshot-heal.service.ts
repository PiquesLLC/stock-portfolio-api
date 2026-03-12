import prisma from '../utils/prisma';
import { config } from '../config';
import { getPortfolio } from './portfolio.service';
import { getMarketSession } from '../utils/market-hours';

export interface SnapshotGapAnomaly {
  start: string;
  end: string;
  gapMinutes: number;
}

export interface SnapshotSpikeAnomaly {
  from: string;
  to: string;
  fromValue: number;
  toValue: number;
  changePercent: number;
}

export interface SnapshotAnomalyReport {
  userId: string;
  now: string;
  latestSnapshotAt: string | null;
  latestSnapshotAgeMinutes: number | null;
  snapshotsLast24h: number;
  gapAnomalies: SnapshotGapAnomaly[];
  spikeAnomalies: SnapshotSpikeAnomaly[];
  isStale: boolean;
}

export interface SnapshotHealResult {
  dryRun: boolean;
  userId: string;
  anomalies: SnapshotAnomalyReport;
  wouldWrite: boolean;
  didWrite: boolean;
  reasons: string[];
  snapshotPreview: {
    totalValue: number;
    netEquity: number;
    cashBalance: number;
    dailyPL: number;
    dailyPLPercent: number;
    totalPL: number;
    totalPLPercent: number;
    holdingsCount: number;
  } | null;
}

const GAP_THRESHOLD_MINUTES = 15;
const SPIKE_THRESHOLD_PERCENT = 25;

function isMarketHours(d: Date): boolean {
  const session = getMarketSession(d);
  return session === 'PRE' || session === 'REG' || session === 'POST';
}

function gapTouchesMarketHours(start: Date, end: Date): boolean {
  const stepMs = 30 * 60 * 1000;
  const startMs = start.getTime();
  const endMs = end.getTime();
  for (let t = startMs; t <= endMs; t += stepMs) {
    if (isMarketHours(new Date(t))) return true;
  }
  return isMarketHours(end);
}

async function createHealAuditRun(jobName: string): Promise<string | null> {
  try {
    const run = await prisma.backgroundJobRun.create({
      data: {
        jobName,
        status: 'running',
        attempt: 1,
        maxAttempts: 1,
      },
      select: { id: true },
    });
    return run.id;
  } catch {
    return null;
  }
}

async function completeHealAuditRun(runId: string | null, status: 'success' | 'failed', startedAtMs: number, error?: string): Promise<void> {
  if (!runId) return;
  await prisma.backgroundJobRun.update({
    where: { id: runId },
    data: {
      status,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      completedAt: new Date(),
      error: error ?? null,
    },
  }).catch(() => undefined);
}

export async function scanForAnomalies(userId: string): Promise<SnapshotAnomalyReport> {
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const staleThresholdMinutes = Math.max(10, Math.ceil((config.snapshotIntervalSeconds * 3) / 60));

  const [latestSnapshot, recentSnapshots] = await Promise.all([
    prisma.portfolioSnapshot.findFirst({
      where: { userId },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    }),
    prisma.portfolioSnapshot.findMany({
      where: { userId, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true, totalValue: true, netEquity: true },
    }),
  ]);

  const latestSnapshotAgeMinutes = latestSnapshot
    ? (now.getTime() - latestSnapshot.timestamp.getTime()) / 60000
    : null;

  const gapAnomalies: SnapshotGapAnomaly[] = [];
  for (let i = 1; i < recentSnapshots.length; i++) {
    const prev = recentSnapshots[i - 1].timestamp;
    const curr = recentSnapshots[i].timestamp;
    const gapMinutes = (curr.getTime() - prev.getTime()) / 60000;
    if (gapMinutes > GAP_THRESHOLD_MINUTES && gapTouchesMarketHours(prev, curr)) {
      gapAnomalies.push({
        start: prev.toISOString(),
        end: curr.toISOString(),
        gapMinutes: Math.round(gapMinutes * 10) / 10,
      });
    }
  }

  const spikeAnomalies: SnapshotSpikeAnomaly[] = [];
  for (let i = 1; i < recentSnapshots.length; i++) {
    const prev = recentSnapshots[i - 1];
    const curr = recentSnapshots[i];
    const prevValue = prev.netEquity ?? prev.totalValue;
    const currValue = curr.netEquity ?? curr.totalValue;
    if (!Number.isFinite(prevValue) || prevValue <= 0 || !Number.isFinite(currValue) || currValue <= 0) continue;
    const changePercent = ((currValue - prevValue) / prevValue) * 100;
    if (Math.abs(changePercent) >= SPIKE_THRESHOLD_PERCENT) {
      spikeAnomalies.push({
        from: prev.timestamp.toISOString(),
        to: curr.timestamp.toISOString(),
        fromValue: prevValue,
        toValue: currValue,
        changePercent: Math.round(changePercent * 100) / 100,
      });
    }
  }

  return {
    userId,
    now: now.toISOString(),
    latestSnapshotAt: latestSnapshot?.timestamp.toISOString() ?? null,
    latestSnapshotAgeMinutes: latestSnapshotAgeMinutes != null ? Math.round(latestSnapshotAgeMinutes * 10) / 10 : null,
    snapshotsLast24h: recentSnapshots.length,
    gapAnomalies,
    spikeAnomalies,
    isStale: latestSnapshotAgeMinutes == null || latestSnapshotAgeMinutes > staleThresholdMinutes,
  };
}

export async function healSnapshot(userId: string, opts: { dryRun: boolean }): Promise<SnapshotHealResult> {
  const startedAtMs = Date.now();
  const auditJobName = opts.dryRun ? 'snapshot_heal_dry_run' : 'snapshot_heal';
  const runId = await createHealAuditRun(auditJobName);

  try {
    const anomalies = await scanForAnomalies(userId);
    const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
      where: { userId },
      orderBy: { timestamp: 'desc' },
      select: { totalValue: true, netEquity: true },
    });
    const portfolio = await getPortfolio(userId, { preferPolygon: true });

    const reasons: string[] = [];
    if (anomalies.isStale) reasons.push('stale_snapshots');
    if (anomalies.gapAnomalies.length > 0) reasons.push('snapshot_gaps');
    if (anomalies.spikeAnomalies.length > 0) reasons.push('value_spikes');
    if (!latestSnapshot) reasons.push('no_existing_snapshot');

    const totalHoldings = portfolio.holdings.length;
    const unavailable = portfolio.quotesUnavailableCount ?? 0;
    if (totalHoldings > 0 && unavailable > totalHoldings * 0.5) {
      reasons.push('blocked_majority_quotes_unavailable');
    }
    const zeroPrice = portfolio.holdings.filter(h => h.shares > 0 && h.currentPrice <= 0);
    if (zeroPrice.length > 0) {
      reasons.push('blocked_zero_price_quotes');
    }
    if (portfolio.holdings.length > 0 && portfolio.totalAssets < 100) {
      reasons.push('blocked_total_assets_too_low');
    }

    if (latestSnapshot) {
      const prevValue = latestSnapshot.netEquity ?? latestSnapshot.totalValue;
      if (prevValue > 0) {
        const dropPercent = ((prevValue - portfolio.totalAssets) / prevValue) * 100;
        if (dropPercent > 25) {
          reasons.push('blocked_sudden_drop_guard');
        }
      }
    }

    let dailyPL = 0;
    let dailyPLPercent = 0;
    if (latestSnapshot && latestSnapshot.totalValue > 0) {
      dailyPL = portfolio.totalAssets - latestSnapshot.totalValue;
      dailyPLPercent = (dailyPL / latestSnapshot.totalValue) * 100;
    }

    const snapshotPreview = {
      totalValue: portfolio.totalAssets,
      netEquity: portfolio.totalAssets - portfolio.marginDebt,
      cashBalance: portfolio.cashBalance,
      dailyPL,
      dailyPLPercent,
      totalPL: portfolio.totalPL,
      totalPLPercent: portfolio.totalPLPercent,
      holdingsCount: portfolio.holdings.length,
    };

    const blocked = reasons.some(r => r.startsWith('blocked_'));
    const wouldWrite = !blocked;
    if (opts.dryRun || !wouldWrite) {
      await completeHealAuditRun(runId, 'success', startedAtMs);
      return {
        dryRun: opts.dryRun,
        userId,
        anomalies,
        wouldWrite,
        didWrite: false,
        reasons,
        snapshotPreview,
      };
    }

    const snapshotTime = new Date();
    const created = await prisma.$transaction(async (tx) => {
      const snapshot = await tx.portfolioSnapshot.create({
        data: {
          userId,
          timestamp: snapshotTime,
          totalValue: snapshotPreview.totalValue,
          cashBalance: snapshotPreview.cashBalance,
          dailyPL: snapshotPreview.dailyPL,
          dailyPLPercent: snapshotPreview.dailyPLPercent,
          totalPL: snapshotPreview.totalPL,
          totalPLPercent: snapshotPreview.totalPLPercent,
          netEquity: snapshotPreview.netEquity,
        },
      });

      if (portfolio.holdings.length > 0) {
        await tx.holdingSnapshot.createMany({
          data: portfolio.holdings.map(h => ({
            snapshotId: snapshot.id,
            ticker: h.ticker,
            shares: h.shares,
            price: h.currentPrice,
            marketValue: h.currentValue,
            dayPL: h.dayChange,
            dayPLPercent: h.dayChangePercent,
            timestamp: snapshotTime,
          })),
        });
      }

      return snapshot;
    });

    await completeHealAuditRun(runId, 'success', startedAtMs);
    return {
      dryRun: false,
      userId,
      anomalies,
      wouldWrite: true,
      didWrite: Boolean(created?.id),
      reasons,
      snapshotPreview,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await completeHealAuditRun(runId, 'failed', startedAtMs, errMsg);
    throw error;
  }
}
