import { Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import prisma from '../utils/prisma';
import crypto from 'crypto';
import {
  loginWithPassword,
  setPassword,
  getUserById,
  signup,
  usernameExists,
  emailExists,
  changePassword,
  changeUsername,
  verifyPassword,
  rotateRefreshToken,
  revokeAllRefreshTokens,
  revokeRefreshTokenFamily,
  verifyEmailCode,
  resendVerificationEmail,
  requestPasswordReset,
  requestUsernameReminder,
  resetPasswordWithCode,
  requestEmailChange,
  confirmEmailChange,
  generateAccessToken,
  generateRefreshToken,
  isReservedUsername,
  REFRESH_TOKEN_ROTATION_GRACE_WINDOW_MS,
} from '../services/auth.service';
import { AuthRequest } from '../types/auth';
import { config } from '../config';
import {
  loginSchema,
  signupSchema,
  setPasswordSchema,
  changePasswordSchema,
  changeUsernameSchema,
  deleteAccountSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  forgotUsernameSchema,
  resetPasswordSchema,
  requestEmailChangeSchema,
  confirmEmailChangeSchema,
  formatZodError,
} from '../validators/auth.validators';
import { revokePlaidItemTokenBestEffort } from '../services/plaid.service';
import { getCapturedEmailVerificationCode, sendNewSignupNotification, sendWelcomeEmail } from '../services/email.service';



/**
 * Fire-and-forget a side effect for the enumeration-safe auth endpoints
 * (resend-verification, forgot-password, forgot-username). Those endpoints already
 * return an identical generic 200 for every account state, but AWAITING the work
 * would reopen the same leak as a *timing* oracle: a registered email runs a bcrypt
 * hash + OTP DB writes + an awaited Resend email send (~hundreds of ms), while an
 * unknown email returns after a single lookup. Measuring response latency would then
 * reveal which addresses exist. We invoke the work but do NOT await it, so the
 * response is sent in account-independent time — the first `await` inside the service
 * yields control back here before any registered-only work runs.
 *
 * Errors are reported to Sentry, logged, and swallowed so a background rejection can't
 * crash the process via an unhandled rejection. Do NOT re-add `await` to these handlers
 * — that reopens the timing oracle.
 */
function detachAuthSideEffect(work: Promise<unknown>, label: string): void {
  void work.catch((err: unknown) => {
    // A detached failure carries no request to surface it, so report it to Sentry (as
    // the webhook handlers do) and log the full Error (stack). Without this, a real
    // Resend/DB outage would silently stop reset/verification emails with nothing
    // paging us.
    console.error(`[auth:${label}] background task failed:`, err);
    Sentry.captureException(err, { tags: { component: 'auth_detached', flow: label } });
  });
}

/** Check if user is a waitlist admin by ID or verified email */
function isWaitlistAdmin(userId: string, email?: string | null, emailVerified?: boolean): boolean {
  if (config.waitlistAdminUserIds.includes(userId)) return true;
  // Only grant admin via email if the email is verified — prevents impersonation
  if (email && emailVerified && config.waitlistAdminEmails.includes(email.trim().toLowerCase())) return true;
  return false;
}

// Detect Capacitor (native app) requests.
// Accepts EITHER a native origin OR the explicit opt-in header.
// - Origin 'capacitor://localhost' is set by WKWebView and cannot be spoofed from a browser.
// - 'X-Nala-Native: 1' is sent by the native app as a second signal.
// - With CapacitorHttp.enabled=false, WKWebView handles fetch() directly and CORS
//   preflight may strip custom headers. So origin-only detection is the primary path;
//   the header is a fallback for environments where origin is missing.
// - Security: the response body tokens duplicate what's already in httpOnly cookies.
//   A native origin cannot be spoofed from a web browser.

// Only Capacitor-scheme origins are unforgeable from a browser.
// http://localhost and https://localhost are NOT safe — browsers use them.
const NATIVE_ORIGINS = [
  'capacitor://localhost',
  'ionic://localhost',
  'app://localhost',
];
export function isCapacitorRequest(req: Request): boolean {
  const origin = req.headers.origin;

  // Only trust Capacitor-scheme origins — these cannot be set by a browser
  if (origin && NATIVE_ORIGINS.includes(origin)) return true;

  // Fallback: X-Nala-Native header — the UI sets this on native platforms.
  // Safe because: auth endpoints are the only place this matters, and login
  // is rate-limited. A browser spoofing this header only gets tokens it could
  // already extract from a successful login anyway (pre-auth, no session to steal).
  if (req.headers['x-nala-native'] === '1') return true;

  return false;
}

export function getCookieOptions(req: Request) {
  const capacitor = isCapacitorRequest(req);
  const isProduction = process.env.NODE_ENV === 'production';
  const sameSite = isProduction ? ('none' as const) : (capacitor ? ('none' as const) : ('lax' as const));
  const accessOptions = {
    httpOnly: true,
    secure: isProduction || capacitor,
    sameSite,
    maxAge: 15 * 60 * 1000, // 15 minutes — matches JWT access token expiry
    path: '/',
  };
  const refreshOptions = {
    httpOnly: true,
    secure: isProduction || capacitor,
    sameSite,
    maxAge: config.refreshTokenExpiresInDays * 24 * 60 * 60 * 1000,
    path: '/',
  };
  return { accessOptions, refreshOptions };
}

function clearAllAuthCookies(res: Response, req?: Request): void {
  const capacitor = req ? isCapacitorRequest(req) : false;
  const isProduction = process.env.NODE_ENV === 'production';
  const sameSite = isProduction ? ('none' as const) : (capacitor ? ('none' as const) : ('lax' as const));
  const secure = isProduction || capacitor;
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

    if ('error' in result) {
      res.status(401).json({ error: result.error });
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
    // Only include tokens in response body for native clients (iOS Capacitor).
    // Browser flows use httpOnly cookies — exposing tokens in JSON is unnecessary risk.
    const isNative = isCapacitorRequest(req);
    const body: any = {
      user: { ...result.user, isWaitlistAdmin: isWaitlistAdmin(result.user.id, result.user.email, result.user.emailVerified) },
      ...(isNative ? { accessToken: result.token, refreshToken: result.refreshToken, token: result.token } : {}),
    };
    if (process.env.AUTH_DEBUG === '1') {
      console.error('[AuthRuntime] login response', {
        origin: req.headers.origin,
        nativeHeader: req.headers['x-nala-native'],
        isNative,
        bodyKeys: Object.keys(body),
      });
    }
    res.json(body);
  } catch (error: unknown) {
    console.error('Login error:', error instanceof Error ? error.message : String(error));
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
      isWaitlistAdmin: isWaitlistAdmin(user.id, user.email, user.emailVerified),
    });
  } catch (error: unknown) {
    console.error('Me error:', error instanceof Error ? error.message : String(error));
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
  } catch (error: unknown) {
    console.error('Set password error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to set password' });
  }
}

/**
 * GET /auth/has-password/:username
 */
export async function hasPasswordHandler(req: Request, res: Response): Promise<void> {
  // Always return true to prevent auth-type enumeration
  // The UI only needs this for UX (show password field or not),
  // but this shouldn't be exposed to unauthenticated callers
  res.json({ hasPassword: true });
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
    const isNative = isCapacitorRequest(req);
    const signupBody: any = {
      user: { ...result.user, isWaitlistAdmin: isWaitlistAdmin(result.user.id, result.user.email, result.user.emailVerified) },
      emailVerificationRequired: !result.user.emailVerified,
      ...(isNative ? { accessToken: result.token, refreshToken: result.refreshToken, token: result.token } : {}),
    };
    res.status(201).json(signupBody);

    // Send welcome email to new user (fire and forget)
    sendWelcomeEmail(email, displayName).catch(err => {
      console.warn('[Signup] Failed to send welcome email:', err instanceof Error ? err.message : String(err));
    });

    // Notify admin of new signup (fire and forget)
    if (config.waitlistNotifyEmail) {
      sendNewSignupNotification(config.waitlistNotifyEmail, username, email, displayName).catch(err => {
        console.warn('[Signup] Failed to send admin notification:', err instanceof Error ? err.message : String(err));
      });
    }
  } catch (error: unknown) {
    console.error('Signup error:', error instanceof Error ? error.message : String(error));
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
  } catch (error: unknown) {
    console.error('Verify email error:', error instanceof Error ? error.message : String(error));
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
    // Always return the SAME generic response, in account-independent TIME. Distinct
    // statuses (a 400 "already verified" or a 429) would let an attacker enumerate
    // which emails are registered/verified — and so would latency: awaiting the
    // registered-only work (OTP hash + DB writes + Resend send) makes a known email
    // respond hundreds of ms slower than an unknown one. Fire-and-forget closes both
    // the status and the timing oracle; the IP-level limiter still bounds abuse, as
    // with forgot-password / forgot-username.
    detachAuthSideEffect(resendVerificationEmail(email), 'resend-verification');

    res.json({ message: 'If this email is registered, a verification code was sent.' });
  } catch (error: unknown) {
    console.error('Resend verification error:', error instanceof Error ? error.message : String(error));
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

    // Fire-and-forget: never await account-dependent work, so response latency
    // can't reveal whether the email is registered (see detachAuthSideEffect).
    detachAuthSideEffect(requestPasswordReset(parsed.data.email), 'forgot-password');
    res.json({ message: 'If this email is registered, a reset code was sent.' });
  } catch (error: unknown) {
    console.error('Forgot password error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
}

/**
 * POST /auth/forgot-username
 */
export async function forgotUsernameHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = forgotUsernameSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    // Fire-and-forget: never await account-dependent work, so response latency
    // can't reveal whether the email is registered (see detachAuthSideEffect).
    detachAuthSideEffect(requestUsernameReminder(parsed.data.email), 'forgot-username');
    res.json({ message: 'If this email is registered, your username was sent.' });
  } catch (error: unknown) {
    console.error('Forgot username error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to process username reminder request' });
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
  } catch (error: unknown) {
    console.error('Reset password error:', error instanceof Error ? error.message : String(error));
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
  if (!configuredKey || provided !== configuredKey) {
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

    if (isReservedUsername(username)) {
      res.json({ available: false });
      return;
    }

    const exists = await usernameExists(username);
    res.json({ available: !exists });
  } catch (error: unknown) {
    console.error('Check username error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to check username' });
  }
}

/**
 * POST /auth/request-email-change
 * Step 1 of the two-step email change. Verifies the current password and emails
 * a 6-digit code to the proposed new address. The User row is unchanged until
 * /auth/confirm-email-change is called.
 */
export async function requestEmailChangeHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = requestEmailChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const { currentPassword, newEmail } = parsed.data;
    const result = await requestEmailChange(req.user.userId, currentPassword, newEmail);

    if (!result.success) {
      switch (result.error) {
        case 'INVALID_PASSWORD':
          res.status(401).json({ error: 'Current password is incorrect' });
          return;
        case 'NO_PASSWORD':
          res.status(400).json({ error: 'Set a password on this account before changing email' });
          return;
        case 'SAME_EMAIL':
          res.status(400).json({ error: 'New email must be different from your current email' });
          return;
        case 'EMAIL_TAKEN':
          res.status(409).json({ error: 'That email is already in use' });
          return;
        case 'RATE_LIMITED':
          res.status(429).json({ error: 'Too many email-change requests. Try again later.' });
          return;
        default:
          res.status(404).json({ error: 'User not found' });
          return;
      }
    }

    res.json({ message: 'Verification code sent. Enter it to confirm the change.' });
  } catch (error: unknown) {
    console.error('Request email change error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to start email change' });
  }
}

/**
 * POST /auth/confirm-email-change
 * Step 2 of the two-step email change. Verifies the 6-digit code and applies
 * the email change atomically. Sets emailVerified=true on success.
 */
export async function confirmEmailChangeHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = confirmEmailChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const result = await confirmEmailChange(req.user.userId, parsed.data.code);

    if (!result.success) {
      if (result.error === 'TOO_MANY_ATTEMPTS') {
        res.status(429).json({ error: 'Too many verification attempts', remainingAttempts: 0 });
        return;
      }
      if (result.error === 'EMAIL_TAKEN') {
        res.status(409).json({ error: 'That email was claimed by another account before you confirmed' });
        return;
      }
      res.status(400).json({ error: 'Invalid or expired code', remainingAttempts: result.remainingAttempts });
      return;
    }

    res.json({ message: 'Email updated successfully', email: result.email });
  } catch (error: unknown) {
    console.error('Confirm email change error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to confirm email change' });
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
  } catch (error: unknown) {
    console.error('Change password error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to change password' });
  }
}

/**
 * POST /auth/change-username
 */
export async function changeUsernameHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = changeUsernameSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const newUsername = parsed.data.username;
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString();
    const userAgent = req.headers['user-agent'];
    const result = await changeUsername(req.user.userId, newUsername, { ipAddress, userAgent });

    if (!result.success) {
      if (result.error === 'USERNAME_TAKEN') {
        res.status(409).json({ error: 'Username is already taken' });
        return;
      }
      if (result.error === 'SAME_USERNAME') {
        res.status(400).json({ error: 'Username must be different from your current username' });
        return;
      }
      if (result.error === 'USER_NOT_FOUND') {
        res.status(404).json({ error: 'User not found' });
        return;
      }
    }

    if (!result.user) {
      res.status(500).json({ error: 'Failed to change username' });
      return;
    }

    // Revoke the current session's refresh token family so the old token
    // in the DB cannot be reused if it was ever exfiltrated. Other device
    // sessions (separate families) are preserved. Native/iOS clients may
    // send the refresh token in the body rather than as a cookie.
    const oldRefreshToken =
      req.cookies?.refreshToken ||
      (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined);
    if (oldRefreshToken) {
      await revokeRefreshTokenFamily(oldRefreshToken);
    }

    const token = generateAccessToken({
      userId: result.user.id,
      username: result.user.username,
      plan: result.user.plan,
      planExpiresAt: result.user.planExpiresAt ? result.user.planExpiresAt.toISOString() : null,
      emailVerified: result.user.emailVerified,
    });
    const refreshToken = await generateRefreshToken(result.user.id);
    const { accessOptions, refreshOptions } = getCookieOptions(req);
    res.cookie('authToken', token, accessOptions);
    res.cookie('refreshToken', refreshToken, refreshOptions);

    res.json({ username: result.user.username, message: 'Username changed successfully' });
  } catch (error: unknown) {
    console.error('Change username error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to change username' });
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
      // Push notifications (explicit — don't rely solely on cascade)
      await tx.pushSubscription.deleteMany({ where: { userId: user.id } });
      await tx.devicePushToken.deleteMany({ where: { userId: user.id } });
      // MFA
      await tx.mfaMethod.deleteMany({ where: { userId: user.id } });
      await tx.mfaChallenge.deleteMany({ where: { userId: user.id } });
      await tx.mfaBackupCode.deleteMany({ where: { userId: user.id } });
      await tx.emailOtpCode.deleteMany({ where: { userId: user.id } });
      // Social — posts, comments, likes, notifications
      // Extended cleanup — optional chaining + try-catch for models that may not exist in all environments
      try {
      await tx.like?.deleteMany({ where: { userId: user.id } });
      await tx.comment?.deleteMany({ where: { userId: user.id } });
      await tx.post?.deleteMany({ where: { userId: user.id } });
      await tx.socialNotification?.deleteMany({ where: { userId: user.id } });
      await tx.socialNotification?.deleteMany({ where: { actorId: user.id } });
      await tx.activityEvent?.deleteMany({ where: { userId: user.id } });
      await tx.follow?.deleteMany({ where: { followerId: user.id } });
      await tx.follow?.deleteMany({ where: { followingId: user.id } });
      await tx.stockFollow?.deleteMany({ where: { userId: user.id } });
      // User blocking (both directions)
      await tx.userBlock?.deleteMany({ where: { blockerId: user.id } });
      await tx.userBlock?.deleteMany({ where: { blockedId: user.id } });
      // Content moderation (appeal before strike due to FK)
      await tx.appeal?.deleteMany({ where: { userId: user.id } });
      await tx.contentStrike?.deleteMany({ where: { userId: user.id } });
      // UGC reporting (both directions)
      await tx.userReport?.deleteMany({ where: { reporterUserId: user.id } }).catch(() => {});
      await tx.userReport?.deleteMany({ where: { reportedUserId: user.id } }).catch(() => {});
      // Alerts (children before parents)
      await tx.alertEvent?.deleteMany({ where: { alert: { userId: user.id } } });
      await tx.alert?.deleteMany({ where: { userId: user.id } });
      await tx.priceAlertEvent?.deleteMany({ where: { priceAlert: { userId: user.id } } });
      await tx.priceAlert?.deleteMany({ where: { userId: user.id } });
      // Portfolio & holdings (HoldingSnapshots before PortfolioSnapshots)
      const snapshotIds = (await tx.portfolioSnapshot?.findMany({
        where: { userId: user.id },
        select: { id: true },
      }) ?? []).map(s => s.id);
      if (snapshotIds.length > 0) {
        await tx.holdingSnapshot?.deleteMany({ where: { snapshotId: { in: snapshotIds } } });
      }
      await tx.holding?.deleteMany({ where: { userId: user.id } });
      await tx.portfolio?.deleteMany({ where: { userId: user.id } });
      await tx.portfolioSnapshot?.deleteMany({ where: { userId: user.id } });
      await tx.portfolioCompositionChange?.deleteMany({ where: { userId: user.id } });
      // Watchlists (WatchlistHolding cascades via onDelete: Cascade)
      await tx.watchlist?.deleteMany({ where: { userId: user.id } });
      // Trade history & ledger
      await tx.portfolioTrade?.deleteMany({ where: { userId: user.id } });
      await tx.ledgerEvent?.deleteMany({ where: { userId: user.id } });
      // Dividends & lots
      await tx.dismissedDividend?.deleteMany({ where: { userId: user.id } });
      await tx.dividendReinvestment?.deleteMany({ where: { userId: user.id } });
      await tx.dividendCredit?.deleteMany({ where: { userId: user.id } });
      await tx.lot?.deleteMany({ where: { userId: user.id } });
      await tx.transaction?.deleteMany({ where: { userId: user.id } });
      // Goals
      await tx.goal?.deleteMany({ where: { userId: user.id } });
      // Insights & notifications
      await tx.milestoneEvent?.deleteMany({ where: { userId: user.id } });
      await tx.anomalyEvent?.deleteMany({ where: { userId: user.id } });
      await tx.notificationAuditLog?.deleteMany({ where: { userId: user.id } });
      await tx.leaderboardCache?.deleteMany({ where: { userId: user.id } });
      // Verified performance
      await tx.performanceBadge?.deleteMany({ where: { userId: user.id } }).catch(() => {});
      await tx.profileStatsCache?.deleteMany({ where: { userId: user.id } }).catch(() => {});
      // Deep Research
      await tx.deepResearchJob?.deleteMany({ where: { userId: user.id } });
      // Analytics
      await tx.analyticsEvent?.deleteMany({ where: { userId: user.id } });
      // Creator monetization (subscription events/ledger before subscriptions, then creator profile)
      const creatorSubIds = (await tx.creatorSubscription?.findMany({
        where: { OR: [{ subscriberUserId: user.id }, { creatorUserId: user.id }] },
        select: { id: true },
      }) ?? []).map(s => s.id);
      if (creatorSubIds.length > 0) {
        await tx.creatorSubscriptionEvent?.deleteMany({ where: { subscriptionId: { in: creatorSubIds } } });
        await tx.creatorWalletLedger?.deleteMany({ where: { subscriptionId: { in: creatorSubIds } } });
      }
      await tx.creatorSubscription?.deleteMany({ where: { subscriberUserId: user.id } });
      await tx.creatorSubscription?.deleteMany({ where: { creatorUserId: user.id } });
      await tx.creatorWalletLedger?.deleteMany({ where: { creatorUserId: user.id } });
      await tx.creatorPayout?.deleteMany({ where: { creatorUserId: user.id } });
      await tx.creatorReport?.deleteMany({ where: { reporterUserId: user.id } }).catch(() => {});
      await tx.creatorReport?.deleteMany({ where: { creatorUserId: user.id } }).catch(() => {});
      // Creator profile (visibility cascades via onDelete: Cascade)
      const creator = await tx.creator?.findUnique({ where: { userId: user.id } });
      if (creator) {
        await tx.creatorVisibility?.deleteMany({ where: { creatorId: creator.id } });
        await tx.creator?.delete({ where: { userId: user.id } });
      }
      // Referrals (both directions)
      await tx.referral?.deleteMany({ where: { referrerUserId: user.id } }).catch(() => {});
      await tx.referral?.deleteMany({ where: { referredUserId: user.id } }).catch(() => {});
      // Settings & consent
      await tx.userSettings?.deleteMany({ where: { userId: user.id } });
      await tx.consentRecord?.deleteMany({ where: { userId: user.id } });
      } catch (cleanupErr) {
        console.warn('[DeleteAccount] Extended cleanup partial failure (non-fatal):', cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr));
      }
      // Finally, delete the user
      await tx.user.delete({ where: { id: user.id } });
    });

    clearAllAuthCookies(res, req);
    res.json({ message: 'Account deleted successfully' });
  } catch (error: unknown) {
    console.error('Delete account error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to delete account' });
  }
}

/**
 * POST /auth/refresh
 */
export async function refreshHandler(req: Request, res: Response): Promise<void> {
  try {
    const isNative = isCapacitorRequest(req);

    // Fix 3: Only accept refreshToken from request body for native clients.
    // Browser flows must use the httpOnly cookie exclusively.
    const token = isNative
      ? (req.body?.refreshToken || req.cookies?.refreshToken)
      : req.cookies?.refreshToken;

    if (!token || typeof token !== 'string') {
      res.status(401).json({ error: 'Refresh token is required', code: 'NO_TOKEN' });
      return;
    }

    const result = await rotateRefreshToken(token);

    if (!result) {
      const storedToken = await prisma.refreshToken.findUnique({
        where: { token: crypto.createHash('sha256').update(token).digest('hex') },
        select: { id: true, userId: true, family: true, expiresAt: true, revokedAt: true },
      });
      const nowMs = Date.now();
      let shouldPreserveCookies = false;

      if (
        storedToken &&
        storedToken.revokedAt &&
        nowMs - storedToken.revokedAt.getTime() <= REFRESH_TOKEN_ROTATION_GRACE_WINDOW_MS
      ) {
        const tokenFamily = storedToken.family ?? storedToken.id;
        const activeFamilyToken = await prisma.refreshToken.findFirst({
          where: {
            userId: storedToken.userId,
            family: tokenFamily,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          orderBy: { createdAt: 'desc' },
        });
        shouldPreserveCookies = !!activeFamilyToken;
      }

      const shouldClearCookies = !shouldPreserveCookies;
      if (shouldClearCookies) {
        clearAllAuthCookies(res, req);
      }
      res.status(401).json({ error: 'Invalid or expired refresh token', code: 'TOKEN_INVALID' });
      return;
    }

    const accessToken = result.accessToken || generateAccessToken(result.payload);
    const { accessOptions, refreshOptions } = getCookieOptions(req);
    res.cookie('authToken', accessToken, accessOptions);
    res.cookie('refreshToken', result.refreshToken, refreshOptions);
    const refreshBody: any = {
      message: 'Token refreshed successfully',
      ...(isNative ? { accessToken, refreshToken: result.refreshToken, token: accessToken } : {}),
    };
    if (process.env.AUTH_DEBUG === '1') {
      console.error('[AuthRuntime] refresh response', {
        origin: req.headers.origin,
        nativeHeader: req.headers['x-nala-native'],
        isNative,
        bodyKeys: Object.keys(refreshBody),
      });
    }
    res.json(refreshBody);
  } catch (error: unknown) {
    console.error('Refresh token error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to refresh token' });
  }
}
