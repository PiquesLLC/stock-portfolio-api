import jwt, { SignOptions, Secret } from 'jsonwebtoken';
import { JwtPayload } from '../types/auth';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-for-testing-only';

/**
 * Generate a valid JWT token for testing
 */
export function generateTestToken(payload: JwtPayload, expiresIn: number = 60 * 60 * 24 * 7): string {
  const options: SignOptions = { expiresIn };
  return jwt.sign(payload, TEST_JWT_SECRET as Secret, options);
}

/**
 * Generate an expired JWT token for testing
 */
export function generateExpiredToken(payload: JwtPayload): string {
  const options: SignOptions = { expiresIn: -10 };
  return jwt.sign(payload, TEST_JWT_SECRET as Secret, options);
}

/**
 * Generate a token signed with wrong secret
 */
export function generateInvalidToken(payload: JwtPayload): string {
  const options: SignOptions = { expiresIn: 60 * 60 };
  return jwt.sign(payload, 'wrong-secret-key' as Secret, options);
}

/**
 * Default test user payload
 */
export const testUser: JwtPayload = {
  userId: 'test-user-id-123',
  username: 'testuser',
  emailVerified: true,
};

/**
 * Default test user DB record
 */
export const TEST_EMAIL = 'piquesyt@gmail.com';

export const testUserRecord = {
  id: 'test-user-id-123',
  username: 'testuser',
  displayName: 'Test User',
  email: TEST_EMAIL,
  passwordHash: '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012', // placeholder
  createdAt: new Date(),
  profilePublic: true,
};
