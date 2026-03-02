/**
 * Tests locking in security audit fixes:
 * 1. Dividend manual creation/deletion routes disabled (shared market data)
 * 2. Daily report regenerate returns 403 for unverified email
 * 3. Analyst single-event read endpoint removed
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// --- Mock rateLimiters as passthrough ---
vi.mock('../middleware/rateLimiter', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const passthrough = (_req: any, _res: any, next: any) => next();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? passthrough : v]),
  );
});

// --- Mock auth middleware: simulate verified premium user ---
vi.mock('../middleware/auth.middleware', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-1', plan: 'premium', emailVerified: true };
    next();
  },
  requireAuthAllowUnverified: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-1', plan: 'premium', emailVerified: false };
    next();
  },
  optionalAuth: (req: any, _res: any, next: any) => {
    req.user = null;
    next();
  },
}));

vi.mock('../middleware/plan.middleware', () => ({
  requirePlan: () => (_req: any, _res: any, next: any) => next(),
}));

// --- Mock dividend controller handlers ---
vi.mock('../controllers/dividend.controller', () => {
  const ok = (_req: any, res: any) => res.status(200).json({ ok: true });
  return {
    addDividendEvent: ok,
    getEventsHandler: ok,
    getUpcomingHandler: ok,
    removeEvent: ok,
    getCreditsHandler: ok,
    getSummaryHandler: ok,
    syncHandler: ok,
    backfillHandler: ok,
    getReinvestmentsHandler: ok,
    getTimelineHandler: ok,
    reinvestHandler: ok,
    getDripSettingsHandler: ok,
    updateDripSettingsHandler: ok,
  };
});

vi.mock('../controllers/dividend-growth.controller', () => ({
  getDividendGrowthRatesHandler: (_req: any, res: any) => res.status(200).json({ ok: true }),
}));

vi.mock('../controllers/calendar.controller', () => ({
  getCalendarICS: (_req: any, res: any) => res.status(200).json({ ok: true }),
}));

// --- Mock insights controller: regenerate throws EmailVerificationRequiredError ---
import { EmailVerificationRequiredError } from '../services/email-verification-guard.service';

vi.mock('../services/email-verification-guard.service', () => {
  class EmailVerificationRequiredError extends Error {
    constructor() {
      super('Email verification required');
      this.name = 'EmailVerificationRequiredError';
    }
  }
  return { EmailVerificationRequiredError };
});

vi.mock('../services/perplexity-daily-report.service', () => ({
  getDailyReport: vi.fn(),
  regenerateDailyReport: vi.fn(),
}));

// --- Mock analyst controller handlers ---
vi.mock('../controllers/analyst.controller', () => {
  const ok = (_req: any, res: any) => res.status(200).json({ ok: true });
  return {
    getAnalystEventsHandler: ok,
    getUnreadAnalystCountHandler: ok,
    markAllAnalystEventsReadHandler: ok,
    getAnalystSnapshotHandler: ok,
  };
});

import dividendRoutes from '../routes/dividend.routes';
import analystRoutes from '../routes/analyst.routes';

// ===================================================================
// 1. Dividend manual creation/deletion routes are disabled
// ===================================================================
describe('Dividend routes — manual mutation disabled', () => {
  const app = express();
  app.use(express.json());
  app.use('/dividends', dividendRoutes);

  it('GET /dividends/events is still accessible', async () => {
    const res = await request(app).get('/dividends/events');
    expect(res.status).toBe(200);
  });

  it('POST /dividends/events returns 404 (route disabled)', async () => {
    const res = await request(app)
      .post('/dividends/events')
      .send({ ticker: 'AAPL', exDate: '2026-03-15', payDate: '2026-04-01', amountPerShare: 0.25 });
    // Express returns 404 for unmatched routes
    expect([404, 405]).toContain(res.status);
  });

  it('DELETE /dividends/events/:id returns 404 (route disabled)', async () => {
    const res = await request(app).delete('/dividends/events/some-id');
    expect([404, 405]).toContain(res.status);
  });

  it('POST /dividends/ (backward compat) returns 404 (route disabled)', async () => {
    const res = await request(app)
      .post('/dividends/')
      .send({ ticker: 'MSFT', exDate: '2026-03-20', payDate: '2026-04-15', amountPerShare: 0.75 });
    expect([404, 405]).toContain(res.status);
  });

  it('GET /dividends/ (backward compat) is still accessible', async () => {
    const res = await request(app).get('/dividends/');
    expect(res.status).toBe(200);
  });
});

// ===================================================================
// 2. Daily report regenerate returns 403 for unverified email
// ===================================================================
describe('Daily report regenerate — email verification gate', () => {
  it('returns 403 email_verification_required when user email is unverified', async () => {
    // Import the real controller (not mocked) to test the catch block
    const { regenerateDailyReport } = await import('../services/perplexity-daily-report.service');
    const mockRegenerate = vi.mocked(regenerateDailyReport);
    mockRegenerate.mockRejectedValueOnce(new EmailVerificationRequiredError());

    // Import the real handler
    const { regenerateDailyReportHandler } = await import('../controllers/insights.controller');

    const app = express();
    app.use(express.json());
    // Attach handler directly with a simple auth middleware
    app.post('/regenerate', (req: any, _res, next) => {
      req.user = { userId: 'test-user-1', plan: 'premium', emailVerified: false };
      next();
    }, regenerateDailyReportHandler as any);

    const res = await request(app).post('/regenerate');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('email_verification_required');
    expect(res.body.message).toContain('Verify your email');
  });
});

// ===================================================================
// 3. Analyst single-event read endpoint is removed
// ===================================================================
describe('Analyst routes — single-event read removed', () => {
  const app = express();
  app.use(express.json());
  app.use('/analyst', analystRoutes);

  it('POST /analyst/events/:id/read returns 404 (route removed)', async () => {
    const res = await request(app).post('/analyst/events/some-event-id/read');
    expect([404, 405]).toContain(res.status);
  });

  it('POST /analyst/events/read-all is still accessible', async () => {
    const res = await request(app).post('/analyst/events/read-all');
    expect(res.status).toBe(200);
  });

  it('GET /analyst/events is still accessible', async () => {
    const res = await request(app).get('/analyst/events');
    expect(res.status).toBe(200);
  });

  it('GET /analyst/events/unread-count is still accessible', async () => {
    const res = await request(app).get('/analyst/events/unread-count');
    expect(res.status).toBe(200);
  });
});
