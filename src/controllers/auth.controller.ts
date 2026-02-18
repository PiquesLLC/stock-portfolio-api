import { Request, Response } from 'express';
import prisma from '../utils/prisma';
import { loginWithPassword, setPassword, getUserById, hasPassword, signup, usernameExists, changePassword, verifyPassword, rotateRefreshToken, revokeAllRefreshTokens } from '../services/auth.service';
import { AuthRequest } from '../types/auth';
import { config } from '../config';
import { loginSchema, signupSchema, setPasswordSchema, changePasswordSchema, deleteAccountSchema, formatZodError } from '../validators/auth.validators';
import { revokePlaidItemTokenBestEffort } from '../services/plaid.service';



// Detect Capacitor requests (cross-origin native app) via custom header
function isCapacitorRequest(req: Request): boolean {
  return req.headers['x-capacitor'] === 'true';
}

export function getCookieOptions(req: Request) {
  const capacitor = isCapacitorRequest(req);
  // Use 'lax' for same-origin (works reliably on iOS Safari/PWA), 'none' for Capacitor cross-origin
  const sameSite = capacitor ? 'none' as const : 'lax' as const;
  const accessOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || capacitor,
    sameSite,
    maxAge: 15 * 60 * 1000, // 15 minutes — matches JWT access token expiry
    path: '/',
  };
  const refreshOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || capacitor,
    sameSite,
    maxAge: config.refreshTokenExpiresInDays * 24 * 60 * 60 * 1000,
    path: '/',
  };
  return { accessOptions, refreshOptions };
}

// Legacy static options (used where req is not available)
const _ACCESS_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 15 * 60 * 1000, // 15 minutes — matches JWT access token expiry
  path: '/',
};

const _REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: config.refreshTokenExpiresInDays * 24 * 60 * 60 * 1000,
  path: '/',
};

function clearAllAuthCookies(res: Response, req?: Request): void {
  const capacitor = req ? isCapacitorRequest(req) : false;
  const sameSite = capacitor ? 'none' as const : 'lax' as const;
  const secure = process.env.NODE_ENV === 'production' || capacitor;
  res.clearCookie('authToken', { httpOnly: true, secure, sameSite, path: '/' });
  res.clearCookie('refreshToken', { httpOnly: true, secure, sameSite, path: '/' });
}

/**
 * POST /auth/login
 */
export async function loginHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const { username, password } = parsed.data;
    const result = await loginWithPassword(username, password);

    if (!result) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    // MFA required — return challenge instead of auth cookies
    if ('mfaRequired' in result) {
      res.json(result);
      return;
    }

    const { accessOptions, refreshOptions } = getCookieOptions(req);
    res.cookie('authToken', result.token, accessOptions);
    res.cookie('refreshToken', result.refreshToken, refreshOptions);
    res.json({ user: result.user });
  } catch (_error) {
    console.error('Login error:');
    res.status(500).json({ error: 'Login failed' });
  }
}

/**
 * POST /auth/logout
 */
export async function logoutHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    let userId: string | undefined;

    // Try access token first (signature-verified)
    const authToken = req.cookies?.authToken;
    if (authToken) {
      const { verifyToken } = await import('../services/auth.service');
      const payload = verifyToken(authToken);
      if (payload?.userId) {
        userId = payload.userId;
      }
    }

    // Fallback: look up refresh token in DB to find the user
    if (!userId) {
      const refreshToken = req.cookies?.refreshToken;
      if (refreshToken) {
        const stored = await prisma.refreshToken.findUnique({
          where: { token: refreshToken },
          select: { userId: true },
        });
        if (stored) {
          userId = stored.userId;
        }
      }
    }

    if (userId) {
      await revokeAllRefreshTokens(userId);
    }
  } catch {
    // Best effort — still clear cookies even if lookup fails
  }

  clearAllAuthCookies(res, req);
  res.json({ message: 'Logged out successfully' });
}

/**
 * GET /auth/me
 */
export async function meHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const user = await getUserById(req.user.userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(user);
  } catch (_error) {
    console.error('Me error:');
    res.status(500).json({ error: 'Failed to get user info' });
  }
}

/**
 * POST /auth/set-password
 */
export async function setPasswordHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = setPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    // Use authenticated user's username, not body — prevents setting another user's password
    const { password } = parsed.data;
    const success = await setPassword(req.user.username, password);

    if (!success) {
      res.status(400).json({ error: 'Password is already set. Use change-password instead.' });
      return;
    }

    res.json({ message: 'Password set successfully' });
  } catch (_error) {
    console.error('Set password error:');
    res.status(500).json({ error: 'Failed to set password' });
  }
}

/**
 * GET /auth/has-password/:username
 */
export async function hasPasswordHandler(req: Request, res: Response): Promise<void> {
  try {
    const { username } = req.params;

    if (!username) {
      res.status(400).json({ error: 'Username is required' });
      return;
    }

    const has = await hasPassword(username);
    res.json({ hasPassword: has });
  } catch (_error) {
    console.error('Has password error:');
    res.json({ hasPassword: true });
  }
}

/**
 * POST /auth/signup
 */
export async function signupHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const { username, displayName, password } = parsed.data;

    const exists = await usernameExists(username);
    if (exists) {
      res.status(409).json({ error: 'Username is already taken' });
      return;
    }

    const result = await signup(username, displayName, password, {
      ipAddress: req.ip || req.headers['x-forwarded-for']?.toString(),
      userAgent: req.headers['user-agent'],
    });

    if (!result) {
      res.status(500).json({ error: 'Failed to create account' });
      return;
    }

    const { accessOptions, refreshOptions } = getCookieOptions(req);
    res.cookie('authToken', result.token, accessOptions);
    res.cookie('refreshToken', result.refreshToken, refreshOptions);
    res.status(201).json({ user: result.user });
  } catch (_error) {
    console.error('Signup error:');
    res.status(500).json({ error: 'Failed to create account' });
  }
}

/**
 * GET /auth/check-username/:username
 */
export async function checkUsernameHandler(req: Request, res: Response): Promise<void> {
  try {
    const { username } = req.params;

    if (!username) {
      res.status(400).json({ error: 'Username is required' });
      return;
    }

    const exists = await usernameExists(username);
    res.json({ available: !exists });
  } catch (_error) {
    console.error('Check username error:');
    res.status(500).json({ error: 'Failed to check username' });
  }
}

/**
 * POST /auth/change-password
 */
export async function changePasswordHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const { currentPassword, newPassword } = parsed.data;
    const result = await changePassword(req.user.userId, currentPassword, newPassword);

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    await revokeAllRefreshTokens(req.user.userId);
    res.json({ message: 'Password changed successfully' });
  } catch (_error) {
    console.error('Change password error:');
    res.status(500).json({ error: 'Failed to change password' });
  }
}

/**
 * DELETE /auth/delete-account
 */
export async function deleteAccountHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = deleteAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const { password } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, passwordHash: true },
    });

    if (!user || !user.passwordHash) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }

    // Revoke all Plaid access tokens before deleting (best effort — failures should not block deletion)
    const plaidItems = await prisma.plaidItem.findMany({
      where: { userId: user.id },
      select: { id: true },
    });
    for (const item of plaidItems) {
      await revokePlaidItemTokenBestEffort(item.id, user.id);
    }

    await prisma.$transaction(async (tx) => {
      // Plaid
      await tx.plaidAccount.deleteMany({ where: { plaidItem: { userId: user.id } } });
      await tx.plaidItem.deleteMany({ where: { userId: user.id } });
      // Auth & sessions
      await tx.refreshToken.deleteMany({ where: { userId: user.id } });
      // MFA
      await tx.mfaMethod.deleteMany({ where: { userId: user.id } });
      await tx.mfaChallenge.deleteMany({ where: { userId: user.id } });
      await tx.mfaBackupCode.deleteMany({ where: { userId: user.id } });
      await tx.emailOtpCode.deleteMany({ where: { userId: user.id } });
      // Social
      await tx.activityEvent.deleteMany({ where: { userId: user.id } });
      await tx.follow.deleteMany({ where: { followerId: user.id } });
      await tx.follow.deleteMany({ where: { followingId: user.id } });
      // Alerts (children before parents)
      await tx.alertEvent.deleteMany({ where: { alert: { userId: user.id } } });
      await tx.alert.deleteMany({ where: { userId: user.id } });
      await tx.priceAlertEvent.deleteMany({ where: { priceAlert: { userId: user.id } } });
      await tx.priceAlert.deleteMany({ where: { userId: user.id } });
      // Portfolio & holdings
      await tx.holding.deleteMany({ where: { userId: user.id } });
      await tx.portfolioSnapshot.deleteMany({ where: { userId: user.id } });
      await tx.portfolioCompositionChange.deleteMany({ where: { userId: user.id } });
      // Watchlists (WatchlistHolding cascades via onDelete: Cascade)
      await tx.watchlist.deleteMany({ where: { userId: user.id } });
      // Dividends & lots
      await tx.dividendReinvestment.deleteMany({ where: { userId: user.id } });
      await tx.dividendCredit.deleteMany({ where: { userId: user.id } });
      await tx.lot.deleteMany({ where: { userId: user.id } });
      await tx.transaction.deleteMany({ where: { userId: user.id } });
      // Insights & notifications
      await tx.milestoneEvent.deleteMany({ where: { userId: user.id } });
      await tx.anomalyEvent.deleteMany({ where: { userId: user.id } });
      await tx.notificationAuditLog.deleteMany({ where: { userId: user.id } });
      await tx.leaderboardCache.deleteMany({ where: { userId: user.id } });
      // Settings & consent
      await tx.userSettings.deleteMany({ where: { userId: user.id } });
      await tx.consentRecord.deleteMany({ where: { userId: user.id } });
      // Finally, delete the user
      await tx.user.delete({ where: { id: user.id } });
    });

    clearAllAuthCookies(res, req);
    res.json({ message: 'Account deleted successfully' });
  } catch (_error) {
    console.error('Delete account error:');
    res.status(500).json({ error: 'Failed to delete account' });
  }
}

/**
 * POST /auth/refresh
 */
export async function refreshHandler(req: Request, res: Response): Promise<void> {
  try {
    const token = req.cookies?.refreshToken || req.body?.refreshToken;

    if (!token || typeof token !== 'string') {
      res.status(401).json({ error: 'Refresh token is required', code: 'NO_TOKEN' });
      return;
    }

    const result = await rotateRefreshToken(token);

    if (!result) {
      clearAllAuthCookies(res, req);
      res.status(401).json({ error: 'Invalid or expired refresh token', code: 'TOKEN_INVALID' });
      return;
    }

    const { accessOptions, refreshOptions } = getCookieOptions(req);
    // Race-loser path returns empty accessToken — only update refresh cookie, client retries
    if (result.accessToken) {
      res.cookie('authToken', result.accessToken, accessOptions);
    }
    res.cookie('refreshToken', result.refreshToken, refreshOptions);
    res.json({ message: 'Token refreshed successfully' });
  } catch (_error) {
    console.error('Refresh token error:');
    res.status(500).json({ error: 'Failed to refresh token' });
  }
}

