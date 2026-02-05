import { PrismaClient } from '@prisma/client';
import jwt, { SignOptions, Secret } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
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
 * Generate a JWT token for a user
 */
export function generateToken(payload: JwtPayload): string {
  const secret: Secret = config.jwtSecret;
  // 7 days in seconds
  const options: SignOptions = { expiresIn: 60 * 60 * 24 * 7 };
  return jwt.sign(payload, secret, options);
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

  const token = generateToken({ userId: user.id, username: user.username });

  return {
    token,
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

  const token = generateToken({ userId: user.id, username: user.username });

  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
    },
  };
}
