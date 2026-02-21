import { Request, Response } from 'express';
import { config } from '../config';
import { getFinnhubStatus } from '../utils/finnhub';
import { getPolygonStatus } from '../utils/polygon';
import { getYahooStatus } from '../utils/yahoo-http';
import { getAuthMetrics } from '../utils/auth-metrics';

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
