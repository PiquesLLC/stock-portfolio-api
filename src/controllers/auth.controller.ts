import { Request, Response } from 'express';
import prisma from '../utils/prisma';
import {
  loginWithPassword,
  setPassword,
  getUserById,
  hasPassword,
  signup,
  usernameExists,
  emailExists,
  changePassword,
  verifyPassword,
  rotateRefreshToken,
  revokeAllRefreshTokens,
  revokeRefreshTokenFamily,
  verifyEmailCode,
  resendVerificationEmail,
  requestPasswordReset,
  resetPasswordWithCode,
  generateAccessToken,
  generateRefreshToken,
} from '../services/auth.service';
import { AuthRequest } from '../types/auth';
import { config } from '../config';
import {
  loginSchema,
  signupSchema,
  setPasswordSchema,
  changePasswordSchema,
  deleteAccountSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  formatZodError,
} from '../validators/auth.validators';
import { revokePlaidItemTokenBestEffort } from '../services/plaid.service';
import { getCapturedEmailVerificationCode } from '../services/email.service';



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
    res.json({ user: { ...result.user, isWaitlistAdmin: config.waitlistAdminUserIds.includes(result.user.id) } });
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
    // Only revoke the current device's token family, not all sessions
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      await revokeRefreshTokenFamily(refreshToken);
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

    res.json({
      ...user,
      isWaitlistAdmin: config.waitlistAdminUserIds.includes(user.id),
    });
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

    const { username, email, displayName, password, referralCode } = parsed.data;

    const exists = await usernameExists(username);
    if (exists) {
      res.status(409).json({ error: 'Username is already taken' });
      return;
    }

    const emailTaken = await emailExists(email);
    if (emailTaken) {
      res.status(409).json({ error: 'Email is already in use' });
      return;
    }

    const result = await signup(username, email, displayName, password, {
      ipAddress: req.ip || req.headers['x-forwarded-for']?.toString(),
      userAgent: req.headers['user-agent'],
    }, referralCode);

    if (!result) {
      res.status(500).json({ error: 'Failed to create account' });
      return;
    }

    // Handle reserved username, waitlist gate, or other validation errors
    if ('error' in result) {
      const status = result.error === 'WAITLIST_NOT_APPROVED' ? 403 : 400;
      res.status(status).json({ error: result.error });
      return;
    }

    const { accessOptions, refreshOptions } = getCookieOptions(req);
    res.cookie('authToken', result.token, accessOptions);
    res.cookie('refreshToken', result.refreshToken, refreshOptions);
    res.status(201).json({
      user: result.user,
      emailVerificationRequired: !result.user.emailVerified,
    });
  } catch (_error) {
    console.error('Signup error:');
    res.status(500).json({ error: 'Failed to create account' });
  }
}

/**
 * POST /auth/verify-email (requires auth — uses authenticated user's email, not body)
 */
export async function verifyEmailHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Only accept code from body — email comes from the authenticated user
    const code = req.body?.code;
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'Code must be 6 digits' });
      return;
    }

    // Resolve email from authenticated user, not request body
    const dbUser = await getUserById(req.user.userId);
    if (!dbUser?.email) {
      res.status(400).json({ error: 'No email associated with this account' });
      return;
    }

    const result = await verifyEmailCode(dbUser.email, code);

    if (!result.success) {
      if (result.error === 'TOO_MANY_ATTEMPTS') {
        res.status(429).json({ error: 'Too many verification attempts', remainingAttempts: 0 });
        return;
      }
      res.status(400).json({ error: 'Invalid or expired verification code', remainingAttempts: result.remainingAttempts });
      return;
    }

    // Issue fresh tokens with emailVerified: true so user is immediately unblocked
    // Only when verification actually changed state (result.user present) AND user matches
    if (result.user && result.user.id === req.user.userId) {
      const token = generateAccessToken({
        userId: result.user.id,
        username: result.user.username,
        plan: result.user.plan,
        planExpiresAt: result.user.planExpiresAt ? result.user.planExpiresAt.toISOString() : null,
        emailVerified: true,
      });
      const refreshToken = await generateRefreshToken(result.user.id);
      const { accessOptions, refreshOptions } = getCookieOptions(req);
      res.cookie('authToken', token, accessOptions);
      res.cookie('refreshToken', refreshToken, refreshOptions);
    }

    res.json({ message: 'Email verified successfully' });
  } catch (_error) {
    console.error('Verify email error:');
    res.status(500).json({ error: 'Failed to verify email' });
  }
}

/**
 * POST /auth/resend-verification
 */
export async function resendVerificationHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = resendVerificationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const { email } = parsed.data;
    const result = await resendVerificationEmail(email);

    if (!result.success) {
      if (result.error === 'RATE_LIMIT') {
        res.status(429).json({ error: 'Too many resend attempts. Please try again later.' });
        return;
      }
      if (result.error === 'ALREADY_VERIFIED') {
        res.status(400).json({ error: 'Email is already verified' });
        return;
      }
    }

    res.json({ message: 'If this email is registered, a verification code was sent.' });
  } catch (_error) {
    console.error('Resend verification error:');
    res.status(500).json({ error: 'Failed to resend verification code' });
  }
}

/**
 * POST /auth/forgot-password
 */
export async function forgotPasswordHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    await requestPasswordReset(parsed.data.email);
    res.json({ message: 'If this email is registered, a reset code was sent.' });
  } catch (_error) {
    console.error('Forgot password error:');
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
}

/**
 * POST /auth/reset-password
 */
export async function resetPasswordHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const { email, code, newPassword } = parsed.data;
    const result = await resetPasswordWithCode(email, code, newPassword);

    if (!result.success) {
      if (result.error === 'TOO_MANY_ATTEMPTS') {
        res.status(429).json({ error: 'Too many reset attempts', remainingAttempts: 0 });
        return;
      }
      res.status(400).json({ error: 'Invalid or expired reset code', remainingAttempts: result.remainingAttempts });
      return;
    }

    clearAllAuthCookies(res, req);
    res.json({ message: 'Password reset successfully' });
  } catch (_error) {
    console.error('Reset password error:');
    res.status(500).json({ error: 'Failed to reset password' });
  }
}

/**
 * GET /auth/test/verification-code?email=...
 * Non-production helper endpoint for CI/local smoke tests.
 */
export async function testGetVerificationCodeHandler(req: Request, res: Response): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const configuredKey = process.env.TEST_HELPER_KEY;
  const providedKey = req.headers['x-test-helper-key'];
  const provided = Array.isArray(providedKey) ? providedKey[0] : providedKey;
  if (configuredKey && provided !== configuredKey) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const email = typeof req.query.email === 'string' ? req.query.email : '';
  if (!email || !email.includes('@')) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const code = getCapturedEmailVerificationCode(email);
  if (!code) {
    res.status(404).json({ error: 'Code not available' });
    return;
  }

  res.json({ code });
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
    res.cookie('authToken', result.accessToken, accessOptions);
    res.cookie('refreshToken', result.refreshToken, refreshOptions);
    res.json({ message: 'Token refreshed successfully' });
  } catch (_error) {
    console.error('Refresh token error:');
    res.status(500).json({ error: 'Failed to refresh token' });
  }
}
