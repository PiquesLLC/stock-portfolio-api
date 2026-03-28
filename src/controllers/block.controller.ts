import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { blockUser, unblockUser, getBlockedUsers } from '../services/block.service';

// POST /social/block/:userId
export async function blockUserHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const blockerId = req.user?.userId;
    if (!blockerId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { userId: blockedId } = req.params;
    await blockUser(blockerId, blockedId);
    res.json({ ok: true });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message || 'Failed to block user' });
  }
}

// DELETE /social/block/:userId
export async function unblockUserHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const blockerId = req.user?.userId;
    if (!blockerId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { userId: blockedId } = req.params;
    await unblockUser(blockerId, blockedId);
    res.json({ ok: true });
  } catch (error: unknown) {
    console.error('Error unblocking user:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to unblock user' });
  }
}

// GET /social/blocked
export async function getBlockedUsersHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const blocked = await getBlockedUsers(userId);
    res.json({ blocked });
  } catch (error: unknown) {
    console.error('Error getting blocked users:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to get blocked users' });
  }
}
