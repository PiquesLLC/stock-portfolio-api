import { PrismaClient } from '@prisma/client';
import jwt, { SignOptions, Secret, TokenExpiredError } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { config } from '../config';
import { JwtPayload, LoginResponse } from '../types/auth';

const prisma = new PrismaClient();

const SALT_ROUNDS = 10;

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
    include: { user: { select: { id: true, username: true } } },
  });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    // If a revoked token is reused, revoke the entire family for safety
    if (stored?.revokedAt) {
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return null;
  }

  // Revoke the old token
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  const payload: JwtPayload = { userId: stored.user.id, username: stored.user.username };
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
 * Login with username and password
 */
export async function loginWithPassword(
  username: string,
  password: string
): Promise<LoginResponse | null> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, displayName: true, passwordHash: true },
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

  const token = generateAccessToken({ userId: user.id, username: user.username });
  const refreshToken = await generateRefreshToken(user.id);

  return {
    token,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
    },
  };
}

/**
 * Set or update password for an existing user
 */
export async function setPassword(username: string, password: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { username },
  });

  if (!user) {
    return false;
  }

  const passwordHash = await hashPassword(password);

  await prisma.user.update({
    where: { username },
    data: { passwordHash },
  });

  return true;
}

/**
 * Get user by ID
 */
export async function getUserById(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, displayName: true },
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
  password: string
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

  const user = await prisma.user.create({
    data: {
      username,
      displayName,
      passwordHash,
      profilePublic: true,
    },
    select: { id: true, username: true, displayName: true },
  });

  // Also create UserSettings for the new user
  await prisma.userSettings.create({
    data: {
      userId: user.id,
      cashBalance: 0,
      marginDebt: 0,
      dripEnabled: false,
    },
  });

  const token = generateAccessToken({ userId: user.id, username: user.username });
  const refreshToken = await generateRefreshToken(user.id);

  return {
    token,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
    },
  };
}
