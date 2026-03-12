import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { getPortfolioIntelligence, IntelligenceWindow, PortfolioIntelligenceResponse } from '../services/portfolioIntelligence.service';
import prisma from '../utils/prisma';
import { validatePortfolioOwnership } from '../utils/validatePortfolioOwnership';

const VALID_WINDOWS: IntelligenceWindow[] = ['1d', '5d', '1m'];
const INTELLIGENCE_TIMEOUT_MS = 12_000;

function timeoutResponse(window: IntelligenceWindow) {
  return {
    window,
    contributors: [],
    detractors: [],
    sectorExposure: [],
    beta: null,
    explanation: 'Loading portfolio intelligence...',
    partial: true,
    loading: true,
    source: 'timeout' as const,
    heroStats: null,
    winnersCount: 0,
    losersCount: 0,
    totalGains: 0,
    totalLosses: 0,
    totalAbsMovement: 0,
    netPnL: 0,
  };
}

async function fetchWithTimeout(
  userId: string,
  window: IntelligenceWindow,
  portfolioId?: string
): Promise<PortfolioIntelligenceResponse> {
  const result = await Promise.race([
    getPortfolioIntelligence(userId, window, portfolioId),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('intelligence_timeout')), INTELLIGENCE_TIMEOUT_MS)
    ),
  ]);
  return result;
}

export async function getIntelligenceHandler(req: AuthRequest, res: Response): Promise<void> {
  const portfolioId = req.query.portfolioId as string | undefined;
  const windowParam = req.query.window as string | undefined;
  let window: IntelligenceWindow = '1d';

  if (windowParam && VALID_WINDOWS.includes(windowParam as IntelligenceWindow)) {
    window = windowParam as IntelligenceWindow;
  }

  try {
    await validatePortfolioOwnership(portfolioId, req.user!.userId);
    const intelligence = await fetchWithTimeout(req.user!.userId, window, portfolioId);
    res.json(intelligence);
  } catch (err) {
    const status = (err as any)?.status;
    if (status === 404) {
      res.status(404).json({ error: 'Portfolio not found' });
      return;
    }
    if (err instanceof Error && err.message === 'intelligence_timeout') {
      console.warn(`[Intelligence] Timeout after ${INTELLIGENCE_TIMEOUT_MS}ms for window=${window}`);
      res.json(timeoutResponse(window));
      return;
    }
    console.error('Error getting portfolio intelligence:', err);
    res.status(500).json({
      error: 'Failed to compute portfolio intelligence',
      partial: true,
    });
  }
}

export async function getUserIntelligenceHandler(req: AuthRequest, res: Response): Promise<void> {
  const { userId } = req.params;
  const viewerId = req.user?.userId;
  const isOwner = viewerId === userId;

  // Privacy check: verify user exists and profile is public (or viewer is owner)
  if (!isOwner) {
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { profilePublic: true, holdingsVisibility: true },
    });
    if (!targetUser) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (!targetUser.profilePublic) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const vis = targetUser.holdingsVisibility ?? 'all';
    if (vis !== 'all') {
      // Intelligence reveals full-position signals — deny unless holdings are fully public
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Trade delay: intelligence contributors/detractors reveal recent trades.
    // Block for creators with active trade delay — the data would expose what they traded.
    const creator = await prisma.creator.findUnique({
      where: { userId },
      select: { status: true, visibility: { select: { tradeDelayHours: true } } },
    });
    if (creator?.status === 'active' && creator.visibility?.tradeDelayHours) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
  }

  const windowParam = req.query.window as string | undefined;
  let window: IntelligenceWindow = '1d';

  if (windowParam && VALID_WINDOWS.includes(windowParam as IntelligenceWindow)) {
    window = windowParam as IntelligenceWindow;
  }

  try {
    const intelligence = await fetchWithTimeout(userId, window);
    res.json(intelligence);
  } catch (err) {
    if (err instanceof Error && err.message === 'intelligence_timeout') {
      console.warn(`[Intelligence] Timeout after ${INTELLIGENCE_TIMEOUT_MS}ms for user ${userId.slice(0, 8)} window=${window}`);
      res.json(timeoutResponse(window));
      return;
    }
    console.error('Error getting user intelligence:', err);
    res.status(500).json({
      error: 'Failed to compute portfolio intelligence',
      partial: true,
    });
  }
}
