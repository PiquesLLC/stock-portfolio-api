import { NextFunction, Response } from 'express';
import prisma from '../utils/prisma';
import { AuthRequest } from '../types/auth';
import { CreatorSection, getEntitlement } from '../services/creator.service';

export async function requireCreator(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const creator = await prisma.creator.findUnique({
      where: { userId },
      select: { status: true },
    });
    if (!creator || creator.status !== 'active') {
      res.status(403).json({ error: 'Active creator account required' });
      return;
    }

    next();
  } catch (_error) {
    res.status(500).json({ error: 'Failed to verify creator status' });
  }
}

export function requireCreatorAccess(section: CreatorSection) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const viewerId = req.user?.userId;
      if (!viewerId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const creatorUserId = req.params.userId;
      if (!creatorUserId) {
        res.status(400).json({ error: 'creator userId is required' });
        return;
      }

      const entitlement = await getEntitlement(creatorUserId, viewerId);
      if (!entitlement.accessibleSections.includes(section)) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
      next();
    } catch (_error) {
      res.status(500).json({ error: 'Failed to verify entitlement' });
    }
  };
}

