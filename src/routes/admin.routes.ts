import { Router, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { AuthRequest } from '../types/auth';
import prisma from '../utils/prisma';

const router = Router();

// Only Jon's account can access admin endpoints
const ADMIN_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

function requireAdmin(req: AuthRequest, res: Response, next: Function): void {
  if (!req.user || req.user.userId !== ADMIN_USER_ID) {
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

// GET /admin/user/:userId — view any user's info
router.get('/user/:userId', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: { id: true, username: true, email: true, plan: true, createdAt: true },
  });

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json(user);
});

export default router;
