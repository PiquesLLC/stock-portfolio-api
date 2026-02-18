import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const orderState = {
  planCalled: false,
};

vi.mock('../middleware/rateLimiter', () => {
  const passthrough = (req: any, res: any, next: any) => next();
  return {
    heavyReadLimiter: passthrough,
    mutationLimiter: passthrough,
  };
});

vi.mock('../middleware/auth.middleware', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', plan: 'free' };
    next();
  },
}));

vi.mock('../middleware/email-verification.middleware', () => ({
  requireEmailVerifiedForAi: (_req: any, res: any, _next: any) => {
    res.status(403).json({ error: 'email_verification_required' });
  },
}));

vi.mock('../middleware/plan.middleware', () => ({
  requirePlan: () => (_req: any, _res: any, next: any) => {
    orderState.planCalled = true;
    next();
  },
}));

vi.mock('../controllers/market.controller', () => {
  const ok = (_req: any, res: any) => res.status(200).json({ ok: true });
  return {
    getPrices: ok,
    getQuote: ok,
    getFastQuote: ok,
    getStockDetails: ok,
    getIntraday: ok,
    getHourlyCandles: ok,
    getDailyCandles: ok,
    searchSymbols: ok,
    getBenchmarkClosesHandler: ok,
    getMarketNews: ok,
    getTickerNews: ok,
    getAIEventsHandler: ok,
    getETFHoldingsHandler: ok,
    getAssetAboutHandler: ok,
    askStockQuestionHandler: ok,
    getHistoricalCAGRHandler: ok,
    getHeatmapHandler: ok,
    getNalaScoreHandler: ok,
    getEarningsTrackHandler: ok,
  };
});

vi.mock('../controllers/insights.controller', () => {
  const ok = (_req: any, res: any) => res.status(200).json({ ok: true });
  return {
    getHealthHandler: ok,
    getAttributionHandler: ok,
    getLeakDetectorHandler: ok,
    getRiskForecastHandler: ok,
    getIncomeInsightsHandler: ok,
    getBriefingHandler: ok,
    getBehaviorHandler: ok,
    getDailyReportHandler: ok,
    regenerateDailyReportHandler: ok,
    explainBriefingHandler: ok,
    getEarningsSummaryHandler: ok,
  };
});

vi.mock('../controllers/anomaly.controller', () => {
  const ok = (_req: any, res: any) => res.status(200).json({ ok: true });
  return {
    getAnomaliesHandler: ok,
    getUnreadAnomalyCountHandler: ok,
    markAnomalyReadHandler: ok,
    markAllAnomaliesReadHandler: ok,
  };
});

vi.mock('../controllers/tax-harvest.controller', () => ({
  getTaxHarvestHandler: (_req: any, res: any) => res.status(200).json({ ok: true }),
}));

import marketRoutes from '../routes/market.routes';
import insightsRoutes from '../routes/insights.routes';

describe('AI route middleware order', () => {
  beforeEach(() => {
    orderState.planCalled = false;
  });

  it('blocks /market/stock/:ticker/ask at email verification before plan check', async () => {
    const app = express();
    app.use(express.json());
    app.use('/market', marketRoutes);

    const res = await request(app)
      .post('/market/stock/AAPL/ask')
      .send({ question: 'What is the outlook?' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('email_verification_required');
    expect(orderState.planCalled).toBe(false);
  });

  it('blocks /insights/briefing at email verification before plan check', async () => {
    const app = express();
    app.use(express.json());
    app.use('/insights', insightsRoutes);

    const res = await request(app).get('/insights/briefing');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('email_verification_required');
    expect(orderState.planCalled).toBe(false);
  });
});
