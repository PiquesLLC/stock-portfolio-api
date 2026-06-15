import { Router, Response } from 'express';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import * as Sentry from '@sentry/node';
import { requireAuth } from '../middleware/auth.middleware';
import { config } from '../config';
import { AuthRequest } from '../types/auth';
import prisma from '../utils/prisma';
import { v1LedgerCreate, isV1WalletFrozen } from '../services/v1-wallet-freeze';
import { logSafe } from '../utils/log-safe';
import {
  getModerationDashboardHandler,
  getAppealsHandler,
  resolveAppealHandler,
  unsuspendUserHandler,
} from '../controllers/moderation.controller';
import { pruneBackupsToKeep, BACKUP_DIR, DB_PATH } from '../services/backup.service';

const router = Router();

// Admin gate. Prod Jon is hardcoded as a guaranteed bypass so an empty
// WAITLIST_ADMIN_USER_IDS env can never lock him out. Additional admins
// (e.g. local-dev accounts) are granted via that env var.
const HARDCODED_ADMIN_IDS = ['237198da-612e-411c-9ef8-f267c887a9f1'];

function requireAdmin(req: AuthRequest, res: Response, next: Function): void {
  const userId = req.user?.userId;
  if (!userId || (!HARDCODED_ADMIN_IDS.includes(userId) && !config.waitlistAdminUserIds.includes(userId))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

// POST /admin/set-plan { userId, plan }
router.post('/set-plan', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { userId, plan } = req.body;
  const validPlans = ['free', 'pro', 'premium', 'elite'];

  if (!userId || !plan || !validPlans.includes(plan)) {
    res.status(400).json({ error: 'Requires userId and plan (free|pro|premium|elite)' });
    return;
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { plan },
    select: { id: true, username: true, plan: true },
  });

  res.json({ success: true, user });
});

// PUT /admin/user/:userId — update username/displayName
router.put('/user/:userId', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { username, displayName } = req.body;
  const data: Record<string, string> = {};
  if (username) data.username = username;
  if (displayName) data.displayName = displayName;
  if (Object.keys(data).length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }
  const user = await prisma.user.update({ where: { id: req.params.userId }, data });
  console.log(`[Admin] ${req.user!.userId} updated user ${req.params.userId}: ${JSON.stringify(data)}`);
  res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName } });
});

// GET /admin/user/:userId — view any user's info
router.get('/user/:userId', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: {
      id: true, username: true, email: true, plan: true, createdAt: true,
      stripeCustomerId: true, stripeSubscriptionId: true,
      profilePublic: true, holdingsVisibility: true,
      creator: {
        select: {
          id: true, status: true, stripeConnectId: true, stripeConnectOnboarded: true,
          visibility: { select: { showHoldings: true, tradeDelayHours: true } },
        },
      },
    },
  });

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json(user);
});

// GET /admin/disk-info — list /data contents, DB pragmas, table row counts
router.get('/disk-info', requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const dataDir = '/data';
    const files: Array<{ name: string; sizeMB: number }> = [];
    try {
      for (const name of fs.readdirSync(dataDir)) {
        const full = path.join(dataDir, name);
        try {
          const st = fs.statSync(full);
          if (st.isFile()) {
            files.push({ name, sizeMB: +(st.size / 1024 / 1024).toFixed(2) });
          } else if (st.isDirectory()) {
            // Recurse one level — sums file sizes inside the subdir so phantom
            // space (e.g. /data/backups/) is visible from disk-info instead of
            // requiring code-spelunking like the Apr 26 incident.
            let dirBytes = 0;
            try {
              for (const child of fs.readdirSync(full)) {
                try {
                  const cst = fs.statSync(path.join(full, child));
                  if (cst.isFile()) dirBytes += cst.size;
                } catch { /* skip child */ }
              }
            } catch { /* skip dir */ }
            files.push({ name: name + '/', sizeMB: +(dirBytes / 1024 / 1024).toFixed(2) });
          }
        } catch { /* skip */ }
      }
    } catch { /* /data may not exist locally */ }
    files.sort((a, b) => b.sizeMB - a.sizeMB);

    const pragma: Record<string, unknown> = {};
    for (const p of ['page_count', 'page_size', 'freelist_count', 'auto_vacuum', 'journal_mode']) {
      try {
        const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`PRAGMA ${p}`);
        pragma[p] = rows?.[0] ? Object.values(rows[0])[0] : null;
      } catch (e) {
        pragma[p] = `err: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    const tables = ['HoldingSnapshot', 'BackgroundJobRun', 'JobIdempotencyKey', 'RefreshToken', 'AnalyticsEvent', 'ApiUsageLog', 'ApiRequestLog'];
    const rowCounts: Record<string, number | string> = {};
    for (const t of tables) {
      try {
        const r = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(`SELECT COUNT(*) as n FROM "${t}"`);
        rowCounts[t] = Number(r?.[0]?.n ?? 0);
      } catch (e) {
        rowCounts[t] = `err: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`;
      }
    }

    res.json({ files, pragma, rowCounts });
  } catch (e: unknown) {
    console.error('[Admin] disk-info error:', e instanceof Error ? e.message : String(e));
    Sentry.captureException(e, { tags: { component: 'admin', endpoint: 'disk-info' } });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/cleanup-db — prune old snapshots, expired tokens, old job runs
// TEMPORARY endpoint for production disk cleanup. Remove after use.
// Body: { confirm: 'cleanup-db', aggressive?: boolean }
//   aggressive=true → truncate BackgroundJobRun/ApiUsageLog/AnalyticsEvent entirely
//   and run PRAGMA incremental_vacuum (works when disk is too tight for full VACUUM).
router.post('/cleanup-db', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  if (req.body?.confirm !== 'cleanup-db') {
    res.status(400).json({ error: 'Missing confirmation token' });
    return;
  }
  const aggressive = req.body?.aggressive === true;

  const log: string[] = [];
  try {
    // Step 1: Small tables
    const rt = await prisma.$executeRawUnsafe(`DELETE FROM "RefreshToken" WHERE "expiresAt" < CURRENT_TIMESTAMP OR "revokedAt" IS NOT NULL`);
    log.push(`RefreshToken: deleted ${rt}`);

    const jk = await prisma.$executeRawUnsafe(`DELETE FROM "JobIdempotencyKey" WHERE "expiresAt" < CURRENT_TIMESTAMP`);
    log.push(`JobIdempotencyKey: deleted ${jk}`);

    if (aggressive) {
      const jr = await prisma.$executeRawUnsafe(`DELETE FROM "BackgroundJobRun" WHERE "startedAt" < datetime('now', '-1 day')`);
      log.push(`BackgroundJobRun (>1d): deleted ${jr}`);
      const ae = await prisma.$executeRawUnsafe(`DELETE FROM "AnalyticsEvent"`);
      log.push(`AnalyticsEvent (all): deleted ${ae}`);
      const al = await prisma.$executeRawUnsafe(`DELETE FROM "ApiUsageLog"`);
      log.push(`ApiUsageLog (all): deleted ${al}`);
    } else {
      const jr = await prisma.$executeRawUnsafe(`DELETE FROM "BackgroundJobRun" WHERE "startedAt" < datetime('now', '-7 days')`);
      log.push(`BackgroundJobRun: deleted ${jr}`);
      const ae = await prisma.$executeRawUnsafe(`DELETE FROM "AnalyticsEvent" WHERE "createdAt" < datetime('now', '-90 days')`);
      log.push(`AnalyticsEvent: deleted ${ae}`);
      const al = await prisma.$executeRawUnsafe(`DELETE FROM "ApiUsageLog" WHERE "createdAt" < datetime('now', '-90 days')`);
      log.push(`ApiUsageLog: deleted ${al}`);
    }

    // Step 2: HoldingSnapshot in chunks. Aggressive → keep last 7d only.
    const snapshotCutoff = aggressive ? '-7 days' : '-30 days';
    let totalHs = 0;
    let chunk = 0;
    while (true) {
      const deleted = await prisma.$executeRawUnsafe(
        `DELETE FROM "HoldingSnapshot" WHERE rowid IN (SELECT rowid FROM "HoldingSnapshot" WHERE "timestamp" < datetime('now', '${snapshotCutoff}') LIMIT 5000)`
      );
      totalHs += deleted;
      chunk++;
      if (deleted < 5000) break;
      if (chunk > 500) break;
    }
    log.push(`HoldingSnapshot total (>${snapshotCutoff}): deleted ${totalHs} in ${chunk} chunks`);

    // Step 3: WAL checkpoint
    await prisma.$executeRawUnsafe(`PRAGMA wal_checkpoint(TRUNCATE)`);
    log.push('WAL checkpoint: done');

    // Step 4a: incremental_vacuum (works in tight-disk scenarios if auto_vacuum is INCREMENTAL)
    try {
      const iv = await prisma.$executeRawUnsafe(`PRAGMA incremental_vacuum`);
      log.push(`incremental_vacuum: ${iv}`);
    } catch (e: unknown) {
      log.push(`incremental_vacuum: skipped (${e instanceof Error ? e.message.slice(0, 120) : String(e)})`);
    }

    // Step 4b: full VACUUM (may fail if still tight)
    // Safety guard added Apr 26: VACUUM rewrites the entire DB and needs
    // ~1× DB size in free space. Running it at tight disk hung prod for
    // ~10 min until forced restart. Skip if free disk < 1.2× DB size.
    try {
      let skipVacuumReason: string | null = null;
      try {
        const dbBytes = fs.statSync(DB_PATH).size;
        const stats = fs.statfsSync('/data');
        const freeBytes = stats.bsize * stats.bavail;
        if (freeBytes < dbBytes * 1.2) {
          const dbMB = (dbBytes / 1024 / 1024).toFixed(0);
          const freeMB = (freeBytes / 1024 / 1024).toFixed(0);
          skipVacuumReason = `disk too tight (free=${freeMB}MB < 1.2× DB=${dbMB}MB)`;
        }
      } catch (e) {
        // If we can't check, fall back to running VACUUM (preserves prior behavior in dev/local)
        log.push(`VACUUM precheck unavailable: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
      }
      if (skipVacuumReason) {
        log.push(`VACUUM: skipped (${skipVacuumReason})`);
      } else {
        await prisma.$executeRawUnsafe(`VACUUM`);
        log.push('VACUUM: done');
      }
    } catch (e: unknown) {
      log.push(`VACUUM: skipped (${e instanceof Error ? e.message.slice(0, 120) : String(e)})`);
    }

    res.json({ success: true, aggressive, log });
  } catch (e: unknown) {
    console.error('[Admin] cleanup-db error:', e instanceof Error ? e.message : String(e));
    Sentry.captureException(e, { tags: { component: 'admin', endpoint: 'cleanup-db' } });
    res.status(500).json({ error: 'Cleanup failed', log });
  }
});

// POST /admin/prune-data-backups — delete all but the N most recent file-system
// backups in /data/backups/. Use when nala.db backups have accumulated past
// MAX_BACKUPS due to retention being sized larger than the volume. This does
// NOT touch the live DB or any SQL state — pure filesystem operation. Safe at
// any disk pressure level.
// Body: { confirm: 'prune-data-backups', keep?: 1 }
router.post('/prune-data-backups', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  if (req.body?.confirm !== 'prune-data-backups') {
    res.status(400).json({ error: 'Missing confirmation token' });
    return;
  }
  const keep = Number.isInteger(req.body?.keep) && req.body.keep >= 0 ? req.body.keep : 1;
  try {
    const result = pruneBackupsToKeep(keep);
    res.json({ success: true, backupDir: BACKUP_DIR, keep, ...result });
  } catch (e: unknown) {
    console.error('[Admin] prune-data-backups error:', e instanceof Error ? e.message : String(e));
    Sentry.captureException(e, { tags: { component: 'admin', endpoint: 'prune-data-backups' } });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/users/privacy — list all non-demo users with privacy settings
router.get('/users/privacy', requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        displayName: true,
        profilePublic: true,
        holdingsVisibility: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ count: users.length, users });
  } catch (e: unknown) {
    console.error('[Admin] users/privacy error:', e instanceof Error ? e.message : String(e));
    Sentry.captureException(e, { tags: { component: 'admin', endpoint: 'users/privacy' } });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/set-privacy { userId, profilePublic } — set a user's profile visibility
router.post('/set-privacy', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { userId, profilePublic } = req.body;

  if (!userId || typeof profilePublic !== 'boolean') {
    res.status(400).json({ error: 'Requires userId (string) and profilePublic (boolean)' });
    return;
  }

  try {
    const before = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, profilePublic: true },
    });

    if (!before) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { profilePublic },
      select: { id: true, username: true, profilePublic: true },
    });

    console.log(`[Admin Privacy] ${req.user!.userId} changed ${userId} (${before.username}) profilePublic: ${before.profilePublic} → ${profilePublic}`);
    res.json({ success: true, before: before.profilePublic, after: user.profilePublic, user });
  } catch (e: unknown) {
    console.error('[Admin] set-privacy error:', e instanceof Error ? e.message : String(e));
    Sentry.captureException(e, { tags: { component: 'admin', endpoint: 'set-privacy' } });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/bulk-set-privacy { userIds, profilePublic } — bulk fix privacy for multiple users
router.post('/bulk-set-privacy', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { userIds, profilePublic } = req.body;

  if (!Array.isArray(userIds) || userIds.length === 0 || typeof profilePublic !== 'boolean') {
    res.status(400).json({ error: 'Requires userIds (string[]) and profilePublic (boolean)' });
    return;
  }

  try {
    const count = await prisma.user.updateMany({
      where: { id: { in: userIds } },
      data: { profilePublic },
    });

    console.log(`[Admin Privacy] ${req.user!.userId} bulk-set profilePublic=${profilePublic} for ${count.count} users: ${userIds.join(', ')}`);
    res.json({ success: true, updated: count.count });
  } catch (e: unknown) {
    console.error('[Admin] bulk-set-privacy error:', e instanceof Error ? e.message : String(e));
    Sentry.captureException(e, { tags: { component: 'admin', endpoint: 'bulk-set-privacy' } });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/user/:userId/strike — record a content moderation strike
router.post('/user/:userId/strike', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { userId } = req.params;
  const { reason, details } = req.body;

  if (!reason || typeof reason !== 'string') {
    res.status(400).json({ error: 'Requires reason (string)' });
    return;
  }

  try {
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, suspended: true },
    });

    if (!targetUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Record the strike
    const strike = await prisma.contentStrike.create({
      data: {
        userId,
        reason,
        details: details || null,
        issuedBy: req.user!.userId,
      },
    });

    // Count total strikes for the user
    const strikeCount = await prisma.contentStrike.count({ where: { userId } });

    // Auto-suspend at >= 3 strikes
    let suspended = targetUser.suspended;
    if (strikeCount >= 3 && !suspended) {
      await prisma.user.update({
        where: { id: userId },
        data: { suspended: true, suspendedAt: new Date() },
      });
      suspended = true;
      console.log(`[Content Moderation] User ${userId} (${targetUser.username}) auto-suspended at ${strikeCount} strikes`);
    }

    res.status(201).json({
      success: true,
      strike: { id: strike.id, reason: strike.reason, createdAt: strike.createdAt },
      strikeCount,
      suspended,
    });
  } catch (e: unknown) {
    console.error('[Admin] strike error:', e instanceof Error ? e.message : String(e));
    Sentry.captureException(e, { tags: { component: 'admin', endpoint: 'strike' } });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/user/:userId/strikes — list all strikes for a user
router.get('/user/:userId/strikes', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { userId } = req.params;

  try {
    const strikes = await prisma.contentStrike.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ userId, strikeCount: strikes.length, strikes });
  } catch (e: unknown) {
    console.error('[Admin] strikes error:', e instanceof Error ? e.message : String(e));
    Sentry.captureException(e, { tags: { component: 'admin', endpoint: 'strikes' } });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Moderation Dashboard & Appeal Management ─────────────────────────

// GET /admin/moderation/dashboard — full moderation overview
router.get('/moderation/dashboard', requireAuth, requireAdmin, getModerationDashboardHandler);

// GET /admin/moderation/appeals — list appeals (default: pending)
router.get('/moderation/appeals', requireAuth, requireAdmin, getAppealsHandler);

// POST /admin/moderation/appeals/:appealId/resolve — resolve an appeal
router.post('/moderation/appeals/:appealId/resolve', requireAuth, requireAdmin, resolveAppealHandler);

// POST /admin/moderation/users/:userId/unsuspend — manually unsuspend a user
router.post('/moderation/users/:userId/unsuspend', requireAuth, requireAdmin, unsuspendUserHandler);

// POST /admin/fix-creator-ledger { creatorUserId, amountCents, idempotencyKey }
// Manually credit a creator ledger pair. Requires an idempotencyKey from the
// caller so re-running the same logical fix is a no-op rather than a duplicate
// mint. The DB unique constraint on (creatorUserId, description) makes the
// second insert fail with P2002 which we surface as 409 Conflict. Bounded:
// amountCents must be a positive integer <= 50000 ($500) to limit blast radius.
router.post('/fix-creator-ledger', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  // Hard-fail when V1_WALLET_FREEZE is active: this endpoint writes only to
  // v1 (no v2 shadow-write yet), so silently no-oping the writes would mean
  // the admin saw HTTP 200 but neither ledger received the row. That's the
  // worst-of-both-worlds outcome. Force ops to either disable the freeze
  // temporarily (and re-enable after) or use a future v2-aware admin path.
  if (isV1WalletFrozen()) {
    console.warn(
      `[Admin Ledger] FREEZE-BLOCKED attempt by ${logSafe(req.user?.userId)} → creatorUserId=${logSafe(req.body?.creatorUserId)}`,
    );
    res.status(503).json({
      error:
        'V1_WALLET_FREEZE is active; v1 manual fixes are disabled. ' +
        'A v2-aware admin fix endpoint is pending post-cutover — prefer waiting for it. ' +
        'If you must proceed, coordinate with on-call FIRST: disabling the freeze re-enables ALL v1 writes process-wide (Stripe webhooks, payouts, etc.), not just this endpoint.',
    });
    return;
  }
  const { creatorUserId, amountCents, idempotencyKey } = req.body;
  if (!creatorUserId || typeof creatorUserId !== 'string') {
    res.status(400).json({ error: 'creatorUserId (string) required' });
    return;
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 50000) {
    res.status(400).json({ error: 'amountCents must be a positive integer <= 50000 ($500 cap per call)' });
    return;
  }
  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    res.status(400).json({ error: 'idempotencyKey (string, 8-128 chars) required' });
    return;
  }
  const sub = await prisma.creatorSubscription.findFirst({
    where: { creatorUserId, status: 'active' },
    select: { id: true },
  });
  if (!sub) { res.status(404).json({ error: 'No active subscription found' }); return; }

  // Exact integer 80% floor — match the webhook writer's split convention so the
  // reconciler doesn't later flag this manual fix as a broken split.
  const creatorShare = Number((BigInt(amountCents) * 80n) / 100n);
  const platformShare = amountCents - creatorShare;
  const actorId = req.user!.userId;
  try {
    await prisma.$transaction([
      v1LedgerCreate(prisma,{
        data: {
          creatorUserId,
          type: 'earning',
          amountCents: creatorShare,
          subscriptionId: sub.id,
          description: `admin_fix:initial_payment:${actorId}:${idempotencyKey}`,
        },
      }),
      v1LedgerCreate(prisma,{
        data: {
          creatorUserId,
          type: 'platform_fee',
          amountCents: platformShare,
          subscriptionId: sub.id,
          description: `admin_fix:platform_fee:${actorId}:${idempotencyKey}`,
        },
      }),
    ]);
    console.log(`[Admin Ledger] ${logSafe(actorId)} credited creator=${logSafe(creatorUserId)} amount=${amountCents} key=${logSafe(idempotencyKey)}`);
    res.json({ success: true, creatorShare, platformShare, idempotencyKey });
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Duplicate idempotencyKey — this fix has already been applied', idempotencyKey });
      return;
    }
    throw e;
  }
});

// ═══════════════════════════════════════════════════════════════
// Automated monitoring — reports from scheduled cloud agents
// ═══════════════════════════════════════════════════════════════

// POST /admin/reports — store a monitoring report (auth via secret key, not JWT)
router.post('/reports', async (req: AuthRequest, res: Response) => {
  try {
    // Constant-time key comparison (avoids a timing oracle on REPORT_API_KEY); reject
    // array-valued headers and a missing/empty configured key.
    const headerVal = req.headers['x-report-key'];
    const provided = Array.isArray(headerVal) ? '' : (headerVal ?? '');
    const expected = process.env.REPORT_API_KEY ?? '';
    const providedBuf = Buffer.from(provided, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (!expected || providedBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      res.status(401).json({ error: 'Invalid report key' });
      return;
    }
    const { type, status, data, source } = req.body;
    if (!type || !status) {
      res.status(400).json({ error: 'type and status required' });
      return;
    }
    await prisma.monitoringReport.create({
      data: {
        type,      // 'health' | 'briefing' | 'security' | 'dev-report'
        status,    // 'ok' | 'warning' | 'critical'
        data: JSON.stringify(data || {}),
        source: source || 'scheduled-agent',
      },
    });
    res.json({ received: true });
  } catch (err) {
    console.error('[Reports] Failed to store report:', err);
    res.status(500).json({ error: 'Failed to store report' });
  }
});

// GET /admin/reports — fetch recent reports (admin only)
router.get('/reports', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const type = req.query.type as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const reports = await prisma.monitoringReport.findMany({
      where: type ? { type } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ reports: reports.map(r => ({ ...r, data: JSON.parse(r.data) })) });
  } catch (err) {
    console.error('[Reports] Failed to fetch reports:', err);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// GET /admin/reports/latest — latest report per type (admin only)
router.get('/reports/latest', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const types = ['health', 'briefing', 'security', 'dev-report'];
    const latest: Record<string, any> = {};
    for (const type of types) {
      const report = await prisma.monitoringReport.findFirst({
        where: { type },
        orderBy: { createdAt: 'desc' },
      });
      if (report) latest[type] = { ...report, data: JSON.parse(report.data) };
    }
    res.json(latest);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

export default router;
