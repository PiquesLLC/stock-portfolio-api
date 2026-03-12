import { Request, Response } from 'express';
import { config } from '../config';
import { getFinnhubStatus } from '../utils/finnhub';
import { getPolygonStatus } from '../utils/polygon';
import { getYahooStatus } from '../utils/yahoo-http';
import { getAuthMetrics } from '../utils/auth-metrics';
import { getWebhookMetrics } from '../utils/webhook-metrics';
import prisma from '../utils/prisma';
import { getJobRunnerMetrics } from '../services/job-runner.service';

export async function healthCheck(req: Request, res: Response): Promise<void> {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
}

export async function authMetrics(req: Request, res: Response): Promise<void> {
  res.json({
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ...getAuthMetrics(),
  });
}

export async function apiUsage(req: Request, res: Response): Promise<void> {
  const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const logs = await prisma.apiUsageLog.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
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
}

export async function webhookMetrics(req: Request, res: Response): Promise<void> {
  res.json(getWebhookMetrics());
}

export async function jobMetrics(req: Request, res: Response): Promise<void> {
  const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 168);
  const metrics = await getJobRunnerMetrics(hours);
  res.json(metrics);
}

export async function healthStatus(req: Request, res: Response): Promise<void> {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
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
