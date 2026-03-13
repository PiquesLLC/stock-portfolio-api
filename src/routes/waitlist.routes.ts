import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { waitlistJoinLimiter } from '../middleware/rateLimiter';
import { config } from '../config';
import prisma from '../utils/prisma';
import { sendWaitlistApprovalEmail, sendWaitlistJoinNotificationEmail } from '../services/email.service';

const router = Router();

async function isWaitlistAdmin(userId: string): Promise<boolean> {
  if (config.waitlistAdminUserIds.includes(userId)) return true;
  // Also check by verified email for newly created admin accounts
  if (config.waitlistAdminEmails.length > 0) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } });
    if (user?.email && user.emailVerified && config.waitlistAdminEmails.includes(user.email.toLowerCase())) return true;
  }
  return false;
}

// Public — join the waitlist (idempotent)
router.post('/join', waitlistJoinLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      res.status(400).json({ error: 'Valid email is required' });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();

    // If email already has an account, return identical response (prevent enumeration)
    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
    if (existingUser) {
      res.json({ success: true });
      return;
    }

    // Idempotent: if already on the list, return identical response (prevent enumeration)
    const existing = await prisma.waitlist.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      res.json({ success: true });
      return;
    }

    await prisma.waitlist.create({ data: { email: normalizedEmail } });

    // Notify admin (non-blocking)
    if (config.waitlistNotifyEmail) {
      sendWaitlistJoinNotificationEmail(config.waitlistNotifyEmail, normalizedEmail).catch(err => {
        console.error('Failed to send waitlist join notification:', err);
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Waitlist join error:', err);
    res.status(500).json({ error: 'Failed to join waitlist' });
  }
});

// Admin — list waitlist entries with optional status filter
router.get('/', requireAuth, async (req: Request, res: Response) => {
  if (!(await isWaitlistAdmin((req as any).user?.userId))) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  const statusFilter = req.query.status as string | undefined;
  const where = statusFilter ? { status: statusFilter } : {};
  const entries = await prisma.waitlist.findMany({ where, orderBy: { createdAt: 'asc' } });
  res.json({
    entries,
    total: entries.length,
    approved: entries.filter(e => e.status === 'approved').length,
    pending: entries.filter(e => e.status === 'pending').length,
  });
});

// Admin — approve a waitlist entry
router.post('/:id/approve', requireAuth, async (req: Request, res: Response) => {
  const adminId = (req as any).user?.userId;
  if (!(await isWaitlistAdmin(adminId))) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  try {
    const entry = await prisma.waitlist.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedAt: new Date(), approvedBy: adminId },
    });

    // Only send approval email if user doesn't already have an account
    const alreadyRegistered = await prisma.user.findUnique({ where: { email: entry.email }, select: { id: true } });
    if (!alreadyRegistered) {
      sendWaitlistApprovalEmail(entry.email).catch(err => {
        console.error('Failed to send waitlist approval email:', err);
      });
    }

    res.json({ entry });
  } catch {
    res.status(404).json({ error: 'Waitlist entry not found' });
  }
});

// Admin — resend approval email
router.post('/:id/resend', requireAuth, async (req: Request, res: Response) => {
  const adminId = (req as any).user?.userId;
  if (!(await isWaitlistAdmin(adminId))) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  try {
    const entry = await prisma.waitlist.findUnique({ where: { id: req.params.id } });
    if (!entry) {
      res.status(404).json({ error: 'Waitlist entry not found' });
      return;
    }
    if (entry.status !== 'approved') {
      res.status(400).json({ error: 'Can only resend email for approved entries' });
      return;
    }
    await sendWaitlistApprovalEmail(entry.email);
    console.log(`[Waitlist] Admin ${adminId} resent approval email to ${entry.email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to resend approval email:', err);
    res.status(500).json({ error: 'Failed to resend email' });
  }
});

// Admin — reject a waitlist entry
router.post('/:id/reject', requireAuth, async (req: Request, res: Response) => {
  if (!(await isWaitlistAdmin((req as any).user?.userId))) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  try {
    const entry = await prisma.waitlist.update({
      where: { id: req.params.id },
      data: { status: 'rejected', rejectedAt: new Date() },
    });
    res.json({ entry });
  } catch {
    res.status(404).json({ error: 'Waitlist entry not found' });
  }
});

export default router;
