import { Router } from 'express';
import authRoutes from './auth.routes';
import healthRoutes from './health.routes';
import marketRoutes from './market.routes';
import portfolioRoutes from './portfolio.routes';
import dividendRoutes from './dividend.routes';
import settingsRoutes from './settings.routes';
import insightsRoutes from './insights.routes';
import goalsRoutes from './goals.routes';
import intelligenceRoutes from './portfolioIntelligence.routes';
import leaderboardRoutes from './leaderboard.routes';
import usersRoutes from './users.routes';
import socialRoutes from './social.routes';
import transactionRoutes from './transaction.routes';
import alertRoutes from './alert.routes';
import priceAlertRoutes from './priceAlert.routes';
import analystRoutes from './analyst.routes';
import milestoneRoutes from './milestone.routes';
import fundamentalsRoutes from './fundamentals.routes';
import nalaRoutes from './nala.routes';
import watchlistRoutes from './watchlist.routes';
import notificationsRoutes from './notifications.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/health', healthRoutes);
router.use('/market', marketRoutes);
router.use('/portfolio', portfolioRoutes);
router.use('/dividends', dividendRoutes);
router.use('/settings', settingsRoutes);
router.use('/insights', insightsRoutes);
router.use('/goals', goalsRoutes);
router.use('/intelligence', intelligenceRoutes);
router.use('/leaderboard', leaderboardRoutes);
router.use('/users', usersRoutes);
router.use('/social', socialRoutes);
router.use('/transactions', transactionRoutes);
router.use('/alerts', alertRoutes);
router.use('/price-alerts', priceAlertRoutes);
router.use('/analyst', analystRoutes);
router.use('/milestones', milestoneRoutes);
router.use('/fundamentals', fundamentalsRoutes);
router.use('/nala', nalaRoutes);
router.use('/watchlists', watchlistRoutes);
router.use('/notifications', notificationsRoutes);

// ── Temporary one-time sync endpoint (REMOVE AFTER USE) ──
router.post('/admin/sync-portfolio', async (req, res) => {
  const { syncKey, holdings, watchlists } = req.body;
  if (syncKey !== 'nala-sync-2026') return res.status(403).json({ error: 'forbidden' });
  const prisma = (await import('../utils/prisma')).default;
  const SYSTEM_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';
  try {
    // Ensure system user
    let user = await prisma.user.findUnique({ where: { id: SYSTEM_USER_ID } });
    if (!user) user = await prisma.user.create({ data: { id: SYSTEM_USER_ID, username: 'system', displayName: 'System' } });

    // Sync holdings: delete extras, upsert targets
    const existing = await prisma.holding.findMany({ where: { userId: SYSTEM_USER_ID } });
    const targetTickers = new Set(holdings.map((h: any) => h.ticker));
    for (const h of existing) {
      if (!targetTickers.has(h.ticker)) await prisma.holding.delete({ where: { id: h.id } });
    }
    for (const h of holdings) {
      const ex = existing.find((e: any) => e.ticker === h.ticker);
      if (ex) await prisma.holding.update({ where: { id: ex.id }, data: { shares: h.shares, averageCost: h.averageCost } });
      else await prisma.holding.create({ data: { userId: SYSTEM_USER_ID, ticker: h.ticker, shares: h.shares, averageCost: h.averageCost } });
    }

    // Sync watchlists: clear old, create new
    const oldWLs = await prisma.watchlist.findMany({ where: { userId: SYSTEM_USER_ID } });
    for (const w of oldWLs) {
      await prisma.watchlistHolding.deleteMany({ where: { watchlistId: w.id } });
      await prisma.watchlist.delete({ where: { id: w.id } });
    }
    for (const wl of (watchlists || [])) {
      const created = await prisma.watchlist.create({
        data: { userId: SYSTEM_USER_ID, name: wl.name, description: wl.description, color: wl.color },
      });
      for (const h of (wl.holdings || [])) {
        await prisma.watchlistHolding.create({
          data: { watchlistId: created.id, ticker: h.ticker, shares: h.shares, averageCost: h.averageCost },
        });
      }
    }

    const finalH = await prisma.holding.findMany({ where: { userId: SYSTEM_USER_ID } });
    const finalW = await prisma.watchlist.findMany({ where: { userId: SYSTEM_USER_ID }, include: { _count: { select: { holdings: true } } } });
    res.json({ success: true, holdings: finalH.length, watchlists: finalW.map(w => ({ name: w.name, holdings: w._count.holdings })) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
