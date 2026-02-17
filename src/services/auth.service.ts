import prisma from '../utils/prisma';
import jwt, { SignOptions, Secret, TokenExpiredError } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { config } from '../config';
import { JwtPayload, LoginResponse, MfaChallengeResponse } from '../types/auth';
import { hasMfaEnabled, createMfaChallenge, getEnabledMethods, getMaskedEmail } from './mfa.service';



const SALT_ROUNDS = 10;
export const CURRENT_POLICY_VERSION = '1.0';

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
export async function generateRefreshToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(64).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + config.refreshTokenExpiresInDays);

  await prisma.refreshToken.create({
    data: { token, userId, expiresAt },
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
    include: { user: { select: { id: true, username: true, plan: true, planExpiresAt: true } } },
  });

  if (!stored || stored.expiresAt < new Date()) {
    return null;
  }

  if (stored.revokedAt) {
    const msSinceRevoked = Date.now() - stored.revokedAt.getTime();
    if (msSinceRevoked > 30_000) {
      // Genuine reuse attack — revoke the entire family for safety
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return null;
    }

    // Grace period: revoked less than 30s ago — concurrent request that raced
    // with the first refresh. Return latest valid refresh token only — NO new
    // access token. Client must use the new refresh token to get an access token.
    const latestValid = await prisma.refreshToken.findFirst({
      where: { userId: stored.userId, revokedAt: null, expiresAt: { gt: new Date() } },
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
      where: { userId: stored.userId, revokedAt: null, expiresAt: { gt: new Date() } },
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
    };
    return { accessToken: '', refreshToken: latestValid.token, payload };
  }

  const payload: JwtPayload = {
    userId: stored.user.id,
    username: stored.user.username,
    plan: stored.user.plan,
    planExpiresAt: stored.user.planExpiresAt ? stored.user.planExpiresAt.toISOString() : null,
  };
  const accessToken = generateAccessToken(payload);
  const refreshToken = await generateRefreshToken(stored.userId);

  return { accessToken, refreshToken, payload };
}

/**
 * Revoke all refresh tokens for a user (e.g., on logout or password change)
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
    select: { id: true, username: true, displayName: true, passwordHash: true, plan: true, planExpiresAt: true },
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
  });
  const refreshToken = await generateRefreshToken(user.id);

  return {
    token,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
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
    select: { id: true, username: true, displayName: true, plan: true, planExpiresAt: true },
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

/**
 * Create a new user account with password
 */
export async function signup(
  username: string,
  displayName: string,
  password: string,
  consentMeta?: { ipAddress?: string; userAgent?: string }
): Promise<LoginResponse | null> {
  // Check if username already exists
  const existing = await prisma.user.findUnique({
    where: { username },
    select: { id: true },
  });

  if (existing) {
    return null;
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        username,
        displayName,
        passwordHash,
        profilePublic: true,
        leaderboardEligible: true,
        trackingStartAt: new Date(),
      },
      select: { id: true, username: true, displayName: true, plan: true, planExpiresAt: true },
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

  const token = generateAccessToken({
    userId: user.id,
    username: user.username,
    plan: user.plan,
    planExpiresAt: user.planExpiresAt ? user.planExpiresAt.toISOString() : null,
  });
  const refreshToken = await generateRefreshToken(user.id);

  return {
    token,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      plan: user.plan,
      planExpiresAt: user.planExpiresAt,
    },
  };
}

