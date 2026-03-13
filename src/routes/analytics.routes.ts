import { Router, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { AuthRequest } from '../types/auth';
import { createEvents, getDashboard, AnalyticsEventInput } from '../services/analytics.service';
import { config } from '../config';

const router = Router();

// ─── Admin guard ─────────────────────────────────────────────────────
const ADMIN_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

function isAdmin(userId?: string): boolean {
  if (!userId) return false;
  return userId === ADMIN_USER_ID ||
    config.waitlistAdminUserIds.includes(userId) ||
    config.creatorAdminUserIds.includes(userId);
}

// ─── POST /analytics/events ──────────────────────────────────────────
// Fire-and-forget telemetry ingestion. userId comes from JWT, not client.
router.post('/events', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { events } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      res.status(400).json({ error: 'events array required' });
      return;
    }

    if (events.length > 50) {
      res.status(400).json({ error: 'Maximum 50 events per batch' });
      return;
    }

    // Validate each event has required fields
    const validated: AnalyticsEventInput[] = [];
    for (const e of events) {
      if (!e.sessionId || !e.event || !e.feature) {
        res.status(400).json({ error: 'Each event requires sessionId, event, and feature' });
        return;
      }
      validated.push({
        sessionId: String(e.sessionId),
        event: String(e.event),
        feature: String(e.feature),
        subFeature: e.subFeature ? String(e.subFeature) : null,
        metadata: e.metadata ? (typeof e.metadata === 'string' ? e.metadata : JSON.stringify(e.metadata)) : null,
        durationMs: typeof e.durationMs === 'number' ? Math.round(e.durationMs) : null,
      });
    }

    // Fire-and-forget — don't await, respond immediately
    createEvents(userId, validated).catch((err) => {
      console.error('[Analytics] Failed to insert events:', err.message);
    });

    res.json({ accepted: validated.length });
  } catch (err: any) {
    console.error('[Analytics] POST /events error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /analytics/dashboard ────────────────────────────────────────
// Admin-only analytics dashboard.
router.get('/dashboard', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!isAdmin(userId)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const period = typeof req.query.period === 'string' ? req.query.period : '7d';
    const validPeriods = ['7d', '30d', '90d'];
    if (!validPeriods.includes(period)) {
      res.status(400).json({ error: 'period must be 7d, 30d, or 90d' });
      return;
    }

    const data = await getDashboard(period);
    res.json(data);
  } catch (err: any) {
    console.error('[Analytics] GET /dashboard error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
