import { Request, Response } from 'express';
import prisma from '../utils/prisma';
import { loginWithPassword, setPassword, getUserById, hasPassword, signup, usernameExists, changePassword, verifyPassword, rotateRefreshToken, revokeAllRefreshTokens } from '../services/auth.service';
import { AuthRequest } from '../types/auth';
import { config } from '../config';
import { loginSchema, signupSchema, setPasswordSchema, changePasswordSchema, deleteAccountSchema, formatZodError } from '../validators/auth.validators';



// Detect Capacitor requests (cross-origin native app) via custom header
function isCapacitorRequest(req: Request): boolean {
  return req.headers['x-capacitor'] === 'true';
}

function getCookieOptions(req: Request) {
  const capacitor = isCapacitorRequest(req);
  // Use 'lax' for same-origin (works reliably on iOS Safari/PWA), 'none' for Capacitor cross-origin
  const sameSite = capacitor ? 'none' as const : 'lax' as const;
  const accessOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || capacitor,
    sameSite,
    maxAge: 15 * 60 * 1000, // 15 minutes
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
const ACCESS_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 15 * 60 * 1000,
  path: '/',
};

const REFRESH_COOKIE_OPTIONS = {
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

    const { accessOptions, refreshOptions } = getCookieOptions(req);
    res.cookie('authToken', result.token, accessOptions);
    res.cookie('refreshToken', result.refreshToken, refreshOptions);
    res.json({ user: result.user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
}

/**
 * POST /auth/logout
 */
export async function logoutHandler(req: AuthRequest, res: Response): Promise<void> {
  if (req.cookies?.refreshToken) {
    try {
      const authToken = req.cookies?.authToken;
      if (authToken) {
        const jwt = await import('jsonwebtoken');
        const decoded = jwt.default.decode(authToken) as { userId?: string } | null;
        if (decoded?.userId) {
          await revokeAllRefreshTokens(decoded.userId);
        }
      }
    } catch {
      // Best effort
    }
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
  } catch (error) {
    console.error('Me error:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
}

/**
 * POST /auth/set-password
 */
export async function setPasswordHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = setPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const { username, password } = parsed.data;
    const success = await setPassword(username, password);

    if (!success) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ message: 'Password set successfully' });
  } catch (error) {
    console.error('Set password error:', error);
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
  } catch (error) {
    console.error('Has password error:', error);
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

    const result = await signup(username, displayName, password);

    if (!result) {
      res.status(500).json({ error: 'Failed to create account' });
      return;
    }

    const { accessOptions, refreshOptions } = getCookieOptions(req);
    res.cookie('authToken', result.token, accessOptions);
    res.cookie('refreshToken', result.refreshToken, refreshOptions);
    res.status(201).json({ user: result.user });
  } catch (error) {
    console.error('Signup error:', error);
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
  } catch (error) {
    console.error('Check username error:', error);
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
  } catch (error) {
    console.error('Change password error:', error);
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

    await prisma.$transaction(async (tx) => {
      await tx.refreshToken.deleteMany({ where: { userId: user.id } });
      await tx.activityEvent.deleteMany({ where: { userId: user.id } });
      await tx.follow.deleteMany({ where: { followerId: user.id } });
      await tx.follow.deleteMany({ where: { followingId: user.id } });
      await tx.alertEvent.deleteMany({ where: { alert: { userId: user.id } } });
      await tx.alert.deleteMany({ where: { userId: user.id } });
      await tx.holding.deleteMany({ where: { userId: user.id } });
      await tx.portfolioSnapshot.deleteMany({ where: { userId: user.id } });
      await tx.userSettings.deleteMany({ where: { userId: user.id } });
      await tx.user.delete({ where: { id: user.id } });
    });

    clearAllAuthCookies(res, req);
    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
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
    res.cookie('authToken', result.accessToken, accessOptions);
    res.cookie('refreshToken', result.refreshToken, refreshOptions);
    res.json({ message: 'Token refreshed successfully' });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
}

