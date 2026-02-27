import prisma from '../utils/prisma';
import jwt, { SignOptions, Secret, TokenExpiredError } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { config } from '../config';
import { JwtPayload, LoginResponse, MfaChallengeResponse } from '../types/auth';
import { hasMfaEnabled, createMfaChallenge, getEnabledMethods, getMaskedEmail } from './mfa.service';
import { sendEmailVerification, sendPasswordResetEmail } from './email.service';



const SALT_ROUNDS = 10;
export const CURRENT_POLICY_VERSION = '1.0';
const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
const EMAIL_VERIFY_MAX_ATTEMPTS = 5;
const EMAIL_RESEND_LIMIT_PER_HOUR = 3;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_REQUEST_LIMIT_PER_HOUR = 3;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateEmailOtpCode(): string {
  return String(crypto.randomInt(100000, 999999));
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
 * Generate a JWT token for a user (backward-compatible, uses legacy 7d expiry)
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
  const token = crypto.randomBytes(64).toString('hex');
  const tokenFamily = family ?? crypto.randomUUID();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + config.refreshTokenExpiresInDays);

  await prisma.refreshToken.create({
    data: { token, userId, family: tokenFamily, expiresAt },
  });

  return token;
}

/**
 * Rotate a refresh token: revoke the old one and issue a new one.
 * Returns null if the provided token is invalid, expired, or already revoked.
 */
export async function rotateRefreshToken(
  oldToken: string
): Promise<{ accessToken: string; refreshToken: string; payload: JwtPayload } | null> {
  const stored = await prisma.refreshToken.findUnique({
    where: { token: oldToken },
    include: { user: { select: { id: true, username: true, plan: true, planExpiresAt: true, emailVerified: true } } },
  });

  if (!stored || stored.expiresAt < new Date()) {
    return null;
  }
  const tokenFamily = stored.family ?? stored.id;

  if (stored.revokedAt) {
    const msSinceRevoked = Date.now() - stored.revokedAt.getTime();
    if (msSinceRevoked > 30_000) {
      // Genuine reuse attack — revoke the entire family for safety
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId, family: tokenFamily, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return null;
    }

    // Grace period: revoked less than 30s ago — concurrent request that raced
    // with the first refresh. Return latest valid refresh token only — NO new
    // access token. Client must use the new refresh token to get an access token.
    const latestValid = await prisma.refreshToken.findFirst({
      where: { userId: stored.userId, family: tokenFamily, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!latestValid) {
      return null;
    }
    const payload: JwtPayload = {
      userId: stored.user.id,
      username: stored.user.username,
      plan: stored.user.plan,
      planExpiresAt: stored.user.planExpiresAt ? stored.user.planExpiresAt.toISOString() : null,
      emailVerified: stored.user.emailVerified ?? false,
    };
    return { accessToken: '', refreshToken: latestValid.token, payload };
  }

  // Atomically revoke the old token — only one concurrent request succeeds
  const revoked = await prisma.refreshToken.updateMany({
    where: { id: stored.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (revoked.count === 0) {
    // Another request already revoked it — return latest valid refresh token only,
    // NO access token. Client must use the new refresh token to get an access token.
    await new Promise(r => setTimeout(r, 50));
    const latestValid = await prisma.refreshToken.findFirst({
      where: { userId: stored.userId, family: tokenFamily, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!latestValid) {
      return null;
    }
    const payload: JwtPayload = {
      userId: stored.user.id,
      username: stored.user.username,
      plan: stored.user.plan,
      planExpiresAt: stored.user.planExpiresAt ? stored.user.planExpiresAt.toISOString() : null,
      emailVerified: stored.user.emailVerified ?? false,
    };
    return { accessToken: '', refreshToken: latestValid.token, payload };
  }

  const payload: JwtPayload = {
    userId: stored.user.id,
    username: stored.user.username,
    plan: stored.user.plan,
    planExpiresAt: stored.user.planExpiresAt ? stored.user.planExpiresAt.toISOString() : null,
    emailVerified: stored.user.emailVerified ?? false,
  };
  const accessToken = generateAccessToken(payload);
  const refreshToken = await generateRefreshToken(stored.userId, tokenFamily);

  return { accessToken, refreshToken, payload };
}

/**
 * Revoke a single refresh token family (e.g., on logout — only affects current device)
 */
export async function revokeRefreshTokenFamily(refreshTokenValue: string): Promise<void> {
  const stored = await prisma.refreshToken.findUnique({
    where: { token: refreshTokenValue },
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
): Promise<LoginResponse | MfaChallengeResponse | null> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      emailVerified: true,
      passwordHash: true,
      plan: true,
      planExpiresAt: true,
    },
  });

  if (!user) {
    return null;
  }

  // Check if user has a password set
  if (!user.passwordHash) {
    return null;
  }

  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) {
    return null;
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
  });

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
export async function signup(
  username: string,
  email: string,
  displayName: string,
  password: string,
  consentMeta?: { ipAddress?: string; userAgent?: string },
  referralCode?: string
): Promise<LoginResponse | null> {
  const normalizedEmail = normalizeEmail(email);

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

  const user = await prisma.$transaction(async (tx) => {
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
    }),
    prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);

  return { success: true, remainingAttempts: PASSWORD_RESET_MAX_ATTEMPTS };
}

