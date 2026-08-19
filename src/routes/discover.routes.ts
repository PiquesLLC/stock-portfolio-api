import { Router, Request, Response } from 'express';
import NodeCache from 'node-cache';
import { getBottlenecksData, buildMomentumResponse } from '../services/ai-bottlenecks.service';
import { getLatestMomentum } from '../services/bottleneck-momentum.service';
import type { EntryMomentum } from '../services/ai-bottlenecks.service';

const router = Router();

/**
 * Momentum changes once a week, so hold it for the same 300s the catalog itself
 * is cached for. Without this the endpoint — previously a pure in-memory read
 * that could not fail — would take two DB round-trips per request and would sit
 * waiting on Prisma under the SQLite write-lock contention this app has
 * documented history of.
 */
const momentumCache = new NodeCache({ stdTTL: 300 });
const MOMENTUM_KEY = 'bottlenecks-momentum';

async function getCachedMomentum(): Promise<Map<string, EntryMomentum>> {
  const hit = momentumCache.get<Map<string, EntryMomentum>>(MOMENTUM_KEY);
  if (hit) return hit;
  const fresh = await getLatestMomentum();
  // Cached even when empty: if the job has not run, this stops every request
  // re-querying to rediscover that.
  momentumCache.set(MOMENTUM_KEY, fresh);
  return fresh;
}

router.get('/bottlenecks', async (_req: Request, res: Response) => {
  try {
    // The catalog itself is static and always available. Momentum is an
    // enhancement layered on top: if the weekly job has not run yet, or the read
    // fails, getLatestMomentum() returns an empty map and buildMomentumResponse
    // hands back the unranked catalog rather than failing the request.
    const base = getBottlenecksData();
    const momentum = await getCachedMomentum();
    res.json(buildMomentumResponse(base, momentum));
  } catch (err) {
    console.error('[Discover] /bottlenecks failed:', err);
    res.status(500).json({ error: 'Failed to load bottlenecks catalog' });
  }
});

/** Drop the memoised momentum map — call after the weekly job writes a new week. */
export function invalidateBottlenecksMomentumCache(): void {
  momentumCache.del(MOMENTUM_KEY);
}

export default router;
