import prisma from '../utils/prisma';
import jwt, { SignOptions, Secret, TokenExpiredError } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { config } from '../config';
import { JwtPayload, LoginResponse, MfaChallengeResponse } from '../types/auth';
import { hasMfaEnabled, createMfaChallenge, getEnabledMethods, getMaskedEmail } from './mfa.service';
import { sendEmailVerification, sendPasswordResetEmail, sendUsernameReminderEmail } from './email.service';



const SALT_ROUNDS = 10;
export const CURRENT_POLICY_VERSION = '1.0';
const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;

/** Hash a refresh token for storage — raw token is only returned to the client. */
function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
const EMAIL_VERIFY_MAX_ATTEMPTS = 5;
const EMAIL_RESEND_LIMIT_PER_HOUR = 3;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_REQUEST_LIMIT_PER_HOUR = 3;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateEmailOtpCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

async function issueEmailVerificationCode(userId: string, email: string): Promise<void> {
  const code = generateEmailOtpCode();
  const codeHash = await bcrypt.hash(code, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MS);

  await prisma.emailOtpCode.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.emailOtpCode.create({
    data: { userId, codeHash, expiresAt },
  });

  try {
    await sendEmailVerification(email, code);
  } catch {
    console.error('Email verification send failed');
  }
}

async function issuePasswordResetCode(userId: string, email: string): Promise<void> {
  const code = generateEmailOtpCode();
  const codeHash = await bcrypt.hash(code, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MS);

  await prisma.emailOtpCode.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.emailOtpCode.create({
    data: { userId, codeHash, expiresAt },
  });

  try {
    await sendPasswordResetEmail(email, code);
  } catch {
    console.error('Password reset send failed');
  }
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a short-lived access token (15 minutes by default)
 */
export function generateAccessToken(payload: JwtPayload): string {
  const secret: Secret = config.jwtSecret;
  // 15 minutes in seconds
  const options: SignOptions = { expiresIn: 15 * 60 };
  return jwt.sign(payload, secret, options);
}

/**
 * @deprecated Use generateAccessToken() for short-lived (15m) access tokens
 * paired with refresh tokens. This function exists only for test compatibility.
 */
export function generateToken(payload: JwtPayload): string {
  const secret: Secret = config.jwtSecret;
  const options: SignOptions = { expiresIn: 60 * 60 * 24 * 7 };
  return jwt.sign(payload, secret, options);
}

/**
 * Generate a cryptographically random refresh token and store it in the database
 */
export async function generateRefreshToken(userId: string, family?: string): Promise<string> {
  const rawToken = crypto.randomBytes(64).toString('hex');
  const tokenHash = hashRefreshToken(rawToken);
  const tokenFamily = family ?? crypto.randomUUID();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + config.refreshTokenExpiresInDays);

  await prisma.refreshToken.create({
    data: { token: tokenHash, userId, family: tokenFamily, expiresAt },
  });

  return rawToken;
}

/**
 * Rotate a refresh token: revoke the old one and issue a new one.
 * Returns null if the provided token is invalid, expired, or already revoked.
 */
export async function rotateRefreshToken(
  oldToken: string
): Promise<{ accessToken: string; refreshToken: string; payload: JwtPayload } | null> {
  const oldTokenHash = hashRefreshToken(oldToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { token: oldTokenHash },
    include: { user: { select: { id: true, username: true, plan: true, planExpiresAt: true, emailVerified: true } } },
  });

  if (!stored || stored.expiresAt < new Date()) {
    return null;
  }
  const tokenFamily = stored.family ?? stored.id;

  const buildPayload = (): JwtPayload => ({
    userId: stored.user.id,
    username: stored.user.username,
    plan: stored.user.plan,
    planExpiresAt: stored.user.planExpiresAt ? stored.user.planExpiresAt.toISOString() : null,
    emailVerified: stored.user.emailVerified ?? false,
  });

  if (stored.revokedAt) {
    // Token was revoked by a previous rotation. Revoke the entire family
    // to prevent replay attacks. This forces re-login on all devices in
    // this family, which is the security-correct behavior.
    // Concurrent legitimate requests are handled by the revoked.count === 0
    // branch below (atomic CAS on revokedAt prevents double-revoke).
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, family: tokenFamily, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return null;
  }

  // Atomically revoke the old token — only one concurrent request succeeds
  const revoked = await prisma.refreshToken.updateMany({
    where: { id: stored.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (revoked.count === 0) {
    // Another concurrent request already revoked and rotated this token.
    // Return null — the client should use the token from the other request's response.
    // Do NOT issue additional tokens (prevents token proliferation).
    return null;
  }

  const payload = buildPayload();
  const accessToken = generateAccessToken(payload);
  const refreshToken = await generateRefreshToken(stored.userId, tokenFamily);

  return { accessToken, refreshToken, payload };
}

/**
 * Revoke a single refresh token family (e.g., on logout — only affects current device)
 */
export async function revokeRefreshTokenFamily(refreshTokenValue: string): Promise<void> {
  const tokenHash = hashRefreshToken(refreshTokenValue);
  const stored = await prisma.refreshToken.findUnique({
    where: { token: tokenHash },
    select: { userId: true, family: true, id: true },
  });
  if (!stored) return;

  const family = stored.family ?? stored.id;
  await prisma.refreshToken.updateMany({
    where: { userId: stored.userId, family, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revoke all refresh tokens for a user (e.g., on password change)
 */
export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Verify a token and distinguish between expired and invalid.
 * Returns { payload, expired } where payload is null if truly invalid.
 */
export function verifyTokenDetailed(token: string): { payload: JwtPayload | null; expired: boolean } {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    return { payload, expired: false };
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      // Decode without verifying expiry to get the payload
      const decoded = jwt.decode(token) as JwtPayload | null;
      return { payload: decoded, expired: true };
    }
    return { payload: null, expired: false };
  }
}

/**
 * Login with username and password.
 * Returns LoginResponse if no MFA, MfaChallengeResponse if MFA enabled, or null if invalid credentials.
 */
export async function loginWithPassword(
  username: string,
  password: string
): Promise<LoginResponse | MfaChallengeResponse | { error: string } | null> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      emailVerified: true,
      passwordHash: true,
      failedLoginAttempts: true,
      lockedUntil: true,
      plan: true,
      planExpiresAt: true,
    },
  } as any) as {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    emailVerified: boolean;
    passwordHash: string | null;
    failedLoginAttempts: number;
    lockedUntil: Date | null;
    plan: string;
    planExpiresAt: Date | null;
  } | null;

  if (!user) {
    return null;
  }

  // Check if user has a password set
  if (!user.passwordHash) {
    return null;
  }

  // Account lockout: return null (same as invalid credentials) to avoid leaking username existence
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return null;
  }

  // If lock has expired, reset attempts before checking password
  const effectiveAttempts = (user.lockedUntil && user.lockedUntil <= new Date()) ? 0 : user.failedLoginAttempts;

  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) {
    const nextFailedLoginAttempts = effectiveAttempts + 1;
    const lockoutThreshold = 10;
    const lockoutDurationMs = 30 * 60 * 1000;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: nextFailedLoginAttempts,
        lockedUntil: nextFailedLoginAttempts >= lockoutThreshold
          ? new Date(Date.now() + lockoutDurationMs)
          : null,
      },
    } as any);

    return null;
  }

  if (user.failedLoginAttempts !== 0 || user.lockedUntil !== null) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    } as any);
  }

  // Check if MFA is enabled — if so, return a challenge instead of tokens
  const mfaEnabled = await hasMfaEnabled(user.id);
  if (mfaEnabled) {
    const challengeToken = await createMfaChallenge(user.id);
    const methods = await getEnabledMethods(user.id);
    const maskedEmail = await getMaskedEmail(user.id);
    return {
      mfaRequired: true,
      challengeToken,
      methods,
      maskedEmail,
    };
  }

  const token = generateAccessToken({
    userId: user.id,
    username: user.username,
    plan: user.plan,
    planExpiresAt: user.planExpiresAt ? user.planExpiresAt.toISOString() : null,
    emailVerified: user.emailVerified ?? false,
  });
  const refreshToken = await generateRefreshToken(user.id);

  return {
    token,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      emailVerified: user.emailVerified,
      plan: user.plan,
      planExpiresAt: user.planExpiresAt,
    },
  };
}

/**
 * Set password for a user who doesn't have one yet (migration path only).
 * Rejects if user already has a password — use changePassword() instead.
 */
export async function setPassword(username: string, password: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);

  // Atomic: only update if passwordHash is currently null
  const result = await prisma.user.updateMany({
    where: { username, passwordHash: null },
    data: { passwordHash },
  });

  return result.count === 1;
}

/**
 * Get user by ID
 */
export async function getUserById(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, displayName: true, email: true, emailVerified: true, plan: true, planExpiresAt: true, createdAt: true },
  });
}

/**
 * Check if a user has a password set
 */
export async function hasPassword(username: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { passwordHash: true },
  });
  return !!user?.passwordHash;
}

/**
 * Change password for authenticated user (requires current password verification)
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });

  if (!user || !user.passwordHash) {
    return { success: false, error: 'User not found' };
  }

  const isValid = await verifyPassword(currentPassword, user.passwordHash);
  if (!isValid) {
    return { success: false, error: 'Current password is incorrect' };
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
    select: { id: true },
  });

  // Revoke all existing sessions — if the user changed their password because
  // they suspect compromise, the attacker's sessions must be invalidated.
  await revokeAllRefreshTokens(userId);

  return { success: true };
}

/**
 * Check if a username is already taken
 */
export async function usernameExists(username: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true },
  });
  return !!user;
}

export async function emailExists(email: string): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  return !!user;
}

/**
 * Create a new user account with password
 */
// Usernames that conflict with API route prefixes, UI tabs, or common reserved words.
// Checked case-insensitively during signup.
const RESERVED_USERNAMES = new Set([
  // System / admin
  '_system', 'system',
  // API route prefixes
  'auth', 'health', 'market', 'portfolio', 'dividends', 'settings', 'insights',
  'goals', 'intelligence', 'leaderboard', 'users', 'social', 'transactions',
  'alerts', 'price-alerts', 'analyst', 'milestones', 'fundamentals', 'nala',
  'watchlists', 'stock-follows', 'creator', 'referral', 'notifications', 'plaid',
  'billing', 'waitlist',
  // UI tab names / routes
  'profile', 'discover', 'feed', 'watch', 'pricing', 'macro',
  // Common reserved words
  'admin', 'api', 'www', 'app', 'help', 'support', 'about', 'login', 'signup',
  'register', 'invite', 'account', 'dashboard', 'home', 'index', 'privacy', 'terms',
  'tos', 'null', 'undefined', 'favicon', 'robots', 'sitemap',
  // Authority / trust impersonation
  'moderator', 'mod', 'staff', 'official', 'verified', 'customer_service',
  'helpdesk', 'operator', 'ceo', 'cto', 'cfo', 'founder', 'developer',
  'engineer', 'security', 'root', 'superuser', 'sysadmin',
  // Brokerage / fintech brand impersonation
  'robinhood', 'fidelity', 'schwab', 'vanguard', 'etrade', 'webull',
  'coinbase', 'binance', 'ameritrade', 'merrill', 'sofi', 'wealthfront',
  'betterment', 'charles_schwab', 'td_ameritrade', 'interactive_brokers',
  // Profanity / slurs
  'fuck', 'shit', 'ass', 'asshole', 'bitch', 'bastard', 'damn', 'dick',
  'pussy', 'cock', 'cunt', 'fag', 'faggot', 'nigger', 'nigga', 'retard',
  'slut', 'whore', 'rape', 'nazi', 'hitler', 'kkk',
]);

// Prefixes that indicate impersonation or abuse
const BLOCKED_PREFIXES = ['admin_', 'mod_', 'staff_', 'official_'];

// Brand substring — always blocked regardless of position
const BLOCKED_SUBSTRINGS_ALWAYS = ['nala'];

// Profanity patterns — matched as whole segments between word boundaries (underscores/digits/start/end)
// This avoids false positives like "scunthorpe" or "shitake"
const BLOCKED_PROFANITY_PATTERN = /(?:^|_)(fuck|shit|nigger|nigga|faggot|cunt|fag)(?:_|$)/;

export function isReservedUsername(username: string): boolean {
  const lower = username.toLowerCase();
  if (RESERVED_USERNAMES.has(lower)) return true;
  if (BLOCKED_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (BLOCKED_SUBSTRINGS_ALWAYS.some((s) => lower.includes(s))) return true;
  if (BLOCKED_PROFANITY_PATTERN.test(lower)) return true;
  return false;
}

export async function signup(
  username: string,
  email: string,
  displayName: string,
  password: string,
  consentMeta?: { ipAddress?: string; userAgent?: string },
  referralCode?: string
): Promise<LoginResponse | { error: string } | null> {
  const normalizedEmail = normalizeEmail(email);

  // Block reserved usernames that would conflict with routes
  if (isReservedUsername(username)) {
    return { error: 'Username is reserved' };
  }

  // Gate signup behind waitlist approval (when enabled)
  // Admin emails bypass the waitlist gate entirely
  if (config.waitlistEnabled && !config.waitlistAdminEmails.includes(normalizedEmail)) {
    const waitlistEntry = await prisma.waitlist.findUnique({ where: { email: normalizedEmail } });
    if (!waitlistEntry || waitlistEntry.status !== 'approved') {
      return { error: 'WAITLIST_NOT_APPROVED' };
    }
  }

  // Check if username already exists
  const existing = await prisma.user.findUnique({
    where: { username },
    select: { id: true },
  });

  if (existing) {
    return null;
  }

  const existingEmail = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (existingEmail) {
    return null;
  }

  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          username,
          email: normalizedEmail,
          emailVerified: false,
          displayName,
          passwordHash,
          profilePublic: true,
          leaderboardEligible: true,
          trackingStartAt: new Date(),
        },
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          emailVerified: true,
          plan: true,
          planExpiresAt: true,
        },
      });

      await tx.userSettings.create({
        data: {
          userId: newUser.id,
          cashBalance: 0,
          marginDebt: 0,
          dripEnabled: false,
        },
      });

      await tx.consentRecord.create({
        data: {
          userId: newUser.id,
          policyVersion: CURRENT_POLICY_VERSION,
          ipAddress: consentMeta?.ipAddress,
          userAgent: consentMeta?.userAgent,
        },
      });

      return newUser;
    });
  } catch (e: unknown) {
    // Handle race condition: username or email taken between check and create
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2002') {
      return null;
    }
    throw e;
  }

  // Mark waitlist entry as converted (non-blocking)
  if (config.waitlistEnabled) {
    prisma.waitlist.update({
      where: { email: normalizedEmail },
      data: { convertedAt: new Date() },
    }).catch(() => { /* non-critical */ });
  }

  // Create default alert preferences (non-blocking — includes congress_trade)
  import('./alert.service').then(m => m.ensureDefaultAlerts(user.id)).catch(() => {});

  // Process referral (non-blocking — don't fail signup if referral fails)
  if (referralCode) {
    try {
      const { processReferral } = await import('./referral.service');
      await processReferral(user.id, referralCode);
    } catch {
      // Referral processing failed — don't block signup
    }
  }

  const token = generateAccessToken({
    userId: user.id,
    username: user.username,
    plan: user.plan,
    planExpiresAt: user.planExpiresAt ? user.planExpiresAt.toISOString() : null,
    emailVerified: user.emailVerified ?? false,
  });
  const refreshToken = await generateRefreshToken(user.id);
  await issueEmailVerificationCode(user.id, normalizedEmail);

  return {
    token,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      emailVerified: user.emailVerified,
      plan: user.plan,
      planExpiresAt: user.planExpiresAt,
    },
  };
}

export async function verifyEmailCode(
  email: string,
  code: string
): Promise<{ success: boolean; remainingAttempts: number; error?: 'INVALID_OR_EXPIRED' | 'TOO_MANY_ATTEMPTS'; user?: { id: string; username: string; plan: string; planExpiresAt: Date | null; emailVerified: boolean } }> {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, username: true, emailVerified: true, plan: true, planExpiresAt: true },
  });
  if (!user) {
    return { success: false, remainingAttempts: EMAIL_VERIFY_MAX_ATTEMPTS, error: 'INVALID_OR_EXPIRED' };
  }
  if (user.emailVerified) {
    // Already verified — return success but NO user object (prevents token reissuance)
    return { success: true, remainingAttempts: EMAIL_VERIFY_MAX_ATTEMPTS };
  }

  const otp = await prisma.emailOtpCode.findFirst({
    where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) {
    return { success: false, remainingAttempts: 0, error: 'INVALID_OR_EXPIRED' };
  }

  const failedAttempts = await prisma.notificationAuditLog.count({
    where: {
      userId: user.id,
      type: 'email_verification_failed',
      sentAt: { gte: otp.createdAt },
    },
  });
  const remainingBefore = EMAIL_VERIFY_MAX_ATTEMPTS - failedAttempts;
  if (remainingBefore <= 0) {
    return { success: false, remainingAttempts: 0, error: 'TOO_MANY_ATTEMPTS' };
  }

  const match = await bcrypt.compare(code, otp.codeHash);
  if (!match) {
    await prisma.notificationAuditLog.create({
      data: {
        userId: user.id,
        type: 'email_verification_failed',
        status: 'failed',
        channel: 'email',
        refKey: crypto.randomUUID(),
      },
    });
    return {
      success: false,
      remainingAttempts: Math.max(0, remainingBefore - 1),
      error: 'INVALID_OR_EXPIRED',
    };
  }

  const usedAt = new Date();
  await prisma.$transaction([
    prisma.emailOtpCode.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
      select: { id: true },
    }),
  ]);

  // Update referral status to 'verified'
  try {
    const { markReferralVerified } = await import('./referral.service');
    await markReferralVerified(user.id);
  } catch {
    // Non-critical
  }

  return { success: true, remainingAttempts: EMAIL_VERIFY_MAX_ATTEMPTS, user: { ...user, emailVerified: true } };
}

export async function resendVerificationEmail(
  email: string
): Promise<{ success: boolean; error?: 'ALREADY_VERIFIED' | 'RATE_LIMIT' }> {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, emailVerified: true },
  });

  // Return success for unknown email to avoid account enumeration.
  if (!user) {
    return { success: true };
  }
  if (user.emailVerified) {
    return { success: false, error: 'ALREADY_VERIFIED' };
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const resentCount = await prisma.notificationAuditLog.count({
    where: {
      userId: user.id,
      type: 'email_verification_resent',
      sentAt: { gte: oneHourAgo },
    },
  });
  if (resentCount >= EMAIL_RESEND_LIMIT_PER_HOUR) {
    return { success: false, error: 'RATE_LIMIT' };
  }

  await issueEmailVerificationCode(user.id, normalizedEmail);
  await prisma.notificationAuditLog.create({
    data: {
      userId: user.id,
      type: 'email_verification_resent',
      status: 'sent',
      channel: 'email',
      refKey: crypto.randomUUID(),
    },
  });

  return { success: true };
}

export async function requestPasswordReset(email: string): Promise<{ success: true }> {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true },
  });

  if (!user?.email) {
    return { success: true };
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const requestCount = await prisma.notificationAuditLog.count({
    where: {
      userId: user.id,
      type: 'password_reset_requested',
      sentAt: { gte: oneHourAgo },
    },
  });

  if (requestCount < PASSWORD_RESET_REQUEST_LIMIT_PER_HOUR) {
    await issuePasswordResetCode(user.id, user.email);
    await prisma.notificationAuditLog.create({
      data: {
        userId: user.id,
        type: 'password_reset_requested',
        status: 'sent',
        channel: 'email',
        refKey: crypto.randomUUID(),
      },
    });
  }

  return { success: true };
}

export async function requestUsernameReminder(email: string): Promise<{ success: true }> {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true, username: true },
  });

  if (!user?.email || !user.username) {
    return { success: true };
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const requestCount = await prisma.notificationAuditLog.count({
    where: {
      userId: user.id,
      type: 'username_reminder_requested',
      sentAt: { gte: oneHourAgo },
    },
  });

  if (requestCount < PASSWORD_RESET_REQUEST_LIMIT_PER_HOUR) {
    await sendUsernameReminderEmail(user.email, user.username);
    await prisma.notificationAuditLog.create({
      data: {
        userId: user.id,
        type: 'username_reminder_requested',
        status: 'sent',
        channel: 'email',
        refKey: crypto.randomUUID(),
      },
    });
  }

  return { success: true };
}

export async function resetPasswordWithCode(
  email: string,
  code: string,
  newPassword: string
): Promise<{ success: boolean; remainingAttempts: number; error?: 'INVALID_OR_EXPIRED' | 'TOO_MANY_ATTEMPTS' }> {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (!user) {
    return { success: false, remainingAttempts: PASSWORD_RESET_MAX_ATTEMPTS, error: 'INVALID_OR_EXPIRED' };
  }

  const otp = await prisma.emailOtpCode.findFirst({
    where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) {
    return { success: false, remainingAttempts: 0, error: 'INVALID_OR_EXPIRED' };
  }

  const failedAttempts = await prisma.notificationAuditLog.count({
    where: {
      userId: user.id,
      type: 'password_reset_failed',
      sentAt: { gte: otp.createdAt },
    },
  });
  const remainingBefore = PASSWORD_RESET_MAX_ATTEMPTS - failedAttempts;
  if (remainingBefore <= 0) {
    return { success: false, remainingAttempts: 0, error: 'TOO_MANY_ATTEMPTS' };
  }

  const match = await bcrypt.compare(code, otp.codeHash);
  if (!match) {
    await prisma.notificationAuditLog.create({
      data: {
        userId: user.id,
        type: 'password_reset_failed',
        status: 'failed',
        channel: 'email',
        refKey: crypto.randomUUID(),
      },
    });
    return {
      success: false,
      remainingAttempts: Math.max(0, remainingBefore - 1),
      error: 'INVALID_OR_EXPIRED',
    };
  }

  const passwordHash = await hashPassword(newPassword);
  const now = new Date();
  await prisma.$transaction([
    prisma.emailOtpCode.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
      select: { id: true },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);

  return { success: true, remainingAttempts: PASSWORD_RESET_MAX_ATTEMPTS };
}

