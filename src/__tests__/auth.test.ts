import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import request from 'supertest';
import { generateTestToken, generateExpiredToken, generateInvalidToken, testUser } from './helpers';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// Disable rate limiters in tests — auto-passthrough for all exports
vi.mock('../middleware/rateLimiter', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const passthrough = (_req: any, _res: any, next: any) => next();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? passthrough : v]),
  );
});

// â”€â”€â”€ Import modules after mocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
import {
  hashPassword,
  verifyPassword,
  generateAccessToken,
  generateToken,
  verifyToken,
  verifyTokenDetailed,
  loginWithPassword,
  setPassword,
  getUserById,
  hasPassword,
  changePassword,
  usernameExists,
  signup,
  generateRefreshToken,
  rotateRefreshToken,
  revokeAllRefreshTokens,
  resetPasswordWithCode,
} from '../services/auth.service';

import { requireAuth, optionalAuth, requireOwnership } from '../middleware/auth.middleware';

// Import Express app for integration tests
import app from '../app';

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AUTH SERVICE UNIT TESTS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
describe('Auth Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no MFA enabled
    prismaMock.mfaMethod.count.mockResolvedValue(0);
    // Default: no grace-period token for refresh rotation
    prismaMock.refreshToken.findFirst.mockResolvedValue(null);
    prismaMock.emailOtpCode.findFirst.mockResolvedValue(null);
    prismaMock.notificationAuditLog.count.mockResolvedValue(0);
    // Default: waitlist not blocking signup
    (prismaMock as any).waitlist.findUnique.mockResolvedValue({ status: 'approved' });
    // Default: no existing user in case-insensitive username lookup
    (prismaMock as any).$queryRaw.mockResolvedValue([]);
  });

  // â”€â”€ Password Hashing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('hashPassword', () => {
    it('should return a bcrypt hash', async () => {
      const hash = await hashPassword('MyPassword1');
      expect(hash).toBeDefined();
      expect(hash).not.toBe('MyPassword1');
      expect(hash.startsWith('$2a$') || hash.startsWith('$2b$')).toBe(true);
    });

    it('should produce different hashes for the same input (salting)', async () => {
      const h1 = await hashPassword('MyPassword1');
      const h2 = await hashPassword('MyPassword1');
      expect(h1).not.toBe(h2);
    });
  });

  // â”€â”€ Password Verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('verifyPassword', () => {
    it('should return true for correct password', async () => {
      const hash = await bcrypt.hash('Correct1', 10);
      const result = await verifyPassword('Correct1', hash);
      expect(result).toBe(true);
    });

    it('should return false for incorrect password', async () => {
      const hash = await bcrypt.hash('Correct1', 10);
      const result = await verifyPassword('Wrong1', hash);
      expect(result).toBe(false);
    });
  });

  // â”€â”€ JWT Access Token Generation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('generateAccessToken', () => {
    it('should return a valid JWT', () => {
      const token = generateAccessToken(testUser);
      expect(typeof token).toBe('string');
      const decoded = jwt.decode(token) as any;
      expect(decoded.userId).toBe(testUser.userId);
      expect(decoded.username).toBe(testUser.username);
    });
  });

  // â”€â”€ Legacy Token Generation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('generateToken', () => {
    it('should return a valid JWT with 7-day expiry', () => {
      const token = generateToken(testUser);
      const decoded = jwt.decode(token) as any;
      expect(decoded.userId).toBe(testUser.userId);
      // 7 days = 604800 seconds
      expect(decoded.exp - decoded.iat).toBe(604800);
    });
  });

  // â”€â”€ Token Verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('verifyToken', () => {
    it('should return payload for valid token', () => {
      const token = generateTestToken(testUser);
      const payload = verifyToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.userId).toBe(testUser.userId);
    });

    it('should return null for expired token', () => {
      const token = generateExpiredToken(testUser);
      const payload = verifyToken(token);
      expect(payload).toBeNull();
    });

    it('should return null for token signed with wrong secret', () => {
      const token = generateInvalidToken(testUser);
      const payload = verifyToken(token);
      expect(payload).toBeNull();
    });

    it('should return null for malformed token', () => {
      const payload = verifyToken('not-a-real-token');
      expect(payload).toBeNull();
    });
  });

  // â”€â”€ Detailed Token Verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('verifyTokenDetailed', () => {
    it('should return { payload, expired: false } for valid token', () => {
      const token = generateTestToken(testUser);
      const result = verifyTokenDetailed(token);
      expect(result.expired).toBe(false);
      expect(result.payload).not.toBeNull();
      expect(result.payload!.userId).toBe(testUser.userId);
    });

    it('should return { payload (decoded), expired: true } for expired token', () => {
      const token = generateExpiredToken(testUser);
      const result = verifyTokenDetailed(token);
      expect(result.expired).toBe(true);
      expect(result.payload).not.toBeNull();
      expect(result.payload!.userId).toBe(testUser.userId);
    });

    it('should return { payload: null, expired: false } for invalid token', () => {
      const result = verifyTokenDetailed('garbage-token');
      expect(result.expired).toBe(false);
      expect(result.payload).toBeNull();
    });

    it('should return { payload: null, expired: false } for wrong-secret token', () => {
      const token = generateInvalidToken(testUser);
      const result = verifyTokenDetailed(token);
      expect(result.expired).toBe(false);
      expect(result.payload).toBeNull();
    });
  });

  // â”€â”€ Login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('loginWithPassword', () => {
    it('should return tokens and user for valid credentials', async () => {
      const hash = await bcrypt.hash('ValidPass1', 10);
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        username: 'alice',
        displayName: 'Alice',
        passwordHash: hash,
      });
      prismaMock.refreshToken.create.mockResolvedValue({ token: 'refresh-tok' });

      const result = await loginWithPassword('alice', 'ValidPass1');

      expect(result).not.toBeNull();
      expect(result!.user.username).toBe('alice');
      expect(typeof result!.token).toBe('string');
      expect(typeof result!.refreshToken).toBe('string');
    });

    it('should return null for non-existent user', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      const result = await loginWithPassword('nobody', 'Pass1234');
      expect(result).toBeNull();
    });

    it('should return null when user has no password set', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-2',
        username: 'bob',
        displayName: 'Bob',
        passwordHash: null,
      });
      const result = await loginWithPassword('bob', 'Pass1234');
      expect(result).toBeNull();
    });

    it('should return null for wrong password', async () => {
      const hash = await bcrypt.hash('CorrectPass1', 10);
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-3',
        username: 'carol',
        displayName: 'Carol',
        passwordHash: hash,
      });
      const result = await loginWithPassword('carol', 'WrongPass1');
      expect(result).toBeNull();
    });
  });

  // â”€â”€ Signup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('signup', () => {
    it('should create user, settings, and return tokens', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null); // username not taken
      prismaMock.user.create.mockResolvedValue({
        id: 'new-user-id',
        username: 'newuser',
        displayName: 'New User',
        email: 'newuser@example.com',
        emailVerified: false,
        plan: 'free',
        planExpiresAt: null,
      });
      prismaMock.userSettings.create.mockResolvedValue({});
      prismaMock.consentRecord.create.mockResolvedValue({});
      prismaMock.emailOtpCode.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.emailOtpCode.create.mockResolvedValue({});
      prismaMock.refreshToken.create.mockResolvedValue({ token: 'refresh-tok' });

      const result = await signup('newuser', 'newuser@example.com', 'New User', 'StrongPass1');

      expect(result).not.toBeNull();
      expect(result!.user.username).toBe('newuser');
      expect(typeof result!.token).toBe('string');
      expect(typeof result!.refreshToken).toBe('string');
      expect(prismaMock.userSettings.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'new-user-id' }),
        })
      );
    });

    it('should return null if username already exists', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'existing-id' });
      const result = await signup('taken', 'taken@example.com', 'Taken User', 'StrongPass1');
      expect(result).toBeNull();
    });
  });

  // â”€â”€ Set Password â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('setPassword', () => {
    it('should update password and return true', async () => {
      prismaMock.user.updateMany.mockResolvedValue({ count: 1 });

      const result = await setPassword('alice', 'NewPass123');
      expect(result).toBe(true);
      expect(prismaMock.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ username: 'alice', passwordHash: null }),
        })
      );
    });

    it('should return false when no matching user found', async () => {
      prismaMock.user.updateMany.mockResolvedValue({ count: 0 });
      const result = await setPassword('ghost', 'NewPass123');
      expect(result).toBe(false);
    });
  });

  // â”€â”€ Get User By ID â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('getUserById', () => {
    it('should return user data', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        username: 'alice',
        displayName: 'Alice',
      });
      const user = await getUserById('u1');
      expect(user).toEqual({ id: 'u1', username: 'alice', displayName: 'Alice' });
    });

    it('should return null for unknown ID', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      const user = await getUserById('unknown');
      expect(user).toBeNull();
    });
  });

  // â”€â”€ Has Password â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('hasPassword', () => {
    it('should return true when password is set', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ passwordHash: '$2a$...' });
      expect(await hasPassword('alice')).toBe(true);
    });

    it('should return false when no password', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ passwordHash: null });
      expect(await hasPassword('bob')).toBe(false);
    });

    it('should return false for non-existent user', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      expect(await hasPassword('ghost')).toBe(false);
    });
  });

  // â”€â”€ Change Password â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('changePassword', () => {
    it('should succeed with correct current password', async () => {
      const hash = await bcrypt.hash('OldPass1', 10);
      prismaMock.user.findUnique.mockResolvedValue({ passwordHash: hash });
      prismaMock.user.update.mockResolvedValue({});

      const result = await changePassword('u1', 'OldPass1', 'NewPass1');
      expect(result.success).toBe(true);
    });

    it('should fail with incorrect current password', async () => {
      const hash = await bcrypt.hash('OldPass1', 10);
      prismaMock.user.findUnique.mockResolvedValue({ passwordHash: hash });

      const result = await changePassword('u1', 'WrongPass1', 'NewPass1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Current password is incorrect');
    });

    it('should fail if user not found', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      const result = await changePassword('u1', 'Any1', 'New1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('User not found');
    });

    it('should fail if user has no password hash', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ passwordHash: null });
      const result = await changePassword('u1', 'Any1', 'New1');
      expect(result.success).toBe(false);
    });
  });

  // â”€â”€ Username Exists â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('usernameExists', () => {
    it('should return true for existing username', async () => {
      (prismaMock as any).$queryRaw.mockResolvedValue([{ id: 'u1' }]);
      expect(await usernameExists('alice')).toBe(true);
    });

    it('should return false for unknown username', async () => {
      (prismaMock as any).$queryRaw.mockResolvedValue([]);
      expect(await usernameExists('ghost')).toBe(false);
    });

    it('should be case-insensitive', async () => {
      (prismaMock as any).$queryRaw.mockResolvedValue([{ id: 'u1' }]);
      expect(await usernameExists('ALICE')).toBe(true);
    });
  });

  // â”€â”€ Refresh Token Generation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('generateRefreshToken', () => {
    it('should create a token in the database and return it', async () => {
      prismaMock.refreshToken.create.mockResolvedValue({ token: 'stored-token' });

      const token = await generateRefreshToken('user-1');
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
      expect(prismaMock.refreshToken.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'user-1' }),
        })
      );
    });

    it('should persist the provided token family', async () => {
      prismaMock.refreshToken.create.mockResolvedValue({ token: 'stored-token' });

      await generateRefreshToken('user-1', 'family-1');

      expect(prismaMock.refreshToken.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'user-1', family: 'family-1' }),
        })
      );
    });
  });

  // â”€â”€ Refresh Token Rotation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('rotateRefreshToken', () => {
    it('should return new tokens for a valid refresh token', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        token: 'old-token',
        userId: 'user-1',
        family: 'family-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
        user: { id: 'user-1', username: 'alice', emailVerified: true },
      });
      prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.refreshToken.create.mockResolvedValue({ token: 'new-refresh' });

      const result = await rotateRefreshToken('old-token');
      expect(result).not.toBeNull();
      expect(result!.payload.userId).toBe('user-1');
      expect(typeof result!.accessToken).toBe('string');
      expect(typeof result!.refreshToken).toBe('string');
    });

    it('should return null for non-existent refresh token', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue(null);
      const result = await rotateRefreshToken('no-such-token');
      expect(result).toBeNull();
    });

    it('should return null when revoked token has no valid family successor', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-2',
        token: 'revoked-token',
        userId: 'user-1',
        family: 'family-1',
        revokedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 86400000),
        user: { id: 'user-1', username: 'alice', emailVerified: true },
      });
      // No valid token in the family
      prismaMock.refreshToken.findFirst.mockResolvedValue(null);

      const result = await rotateRefreshToken('revoked-token');
      expect(result).toBeNull();
    });

    it('should revoke entire family and return null when revoked token is reused (replay attack)', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-2b',
        token: 'revoked-token-recent',
        userId: 'user-1',
        family: 'family-1',
        revokedAt: new Date(Date.now() - 5_000),
        expiresAt: new Date(Date.now() + 86400000),
        user: { id: 'user-1', username: 'alice', plan: 'free', planExpiresAt: null, emailVerified: true },
      });
      prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      const result = await rotateRefreshToken('revoked-token-recent');
      // Revoked token reuse triggers family-wide revocation and returns null
      expect(result).toBeNull();
      // Verify the entire family was revoked
      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1', family: 'family-1', revokedAt: null }),
        })
      );
    });

    it('should revoke the family when a recently rotated token is replayed after a cache miss', async () => {
      const oldToken = 'refresh-stolen-after-restart';
      const oldTokenHash = crypto.createHash('sha256').update(oldToken).digest('hex');
      const user = {
        id: 'user-1',
        username: 'alice',
        plan: 'free',
        planExpiresAt: null,
        emailVerified: true,
      };

      vi.resetModules();
      const firstService = await import('../services/auth.service');
      const firstPrismaModule = await import('../utils/prisma');
      const firstPrisma = firstPrismaModule.__mockPrisma;
      vi.clearAllMocks();

      firstPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-rotate-1',
        token: oldTokenHash,
        userId: user.id,
        family: 'family-rotate-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
        user,
      });
      firstPrisma.refreshToken.updateMany.mockImplementation(async ({ where }: any) => {
        if (where?.id === 'rt-rotate-1') return { count: 1 };
        return { count: 0 };
      });
      firstPrisma.refreshToken.create.mockResolvedValue({ token: 'new-refresh-token' });

      const firstRotation = await firstService.rotateRefreshToken(oldToken);
      expect(firstRotation).not.toBeNull();

      vi.resetModules();
      const replayService = await import('../services/auth.service');
      const replayPrismaModule = await import('../utils/prisma');
      const replayPrisma = replayPrismaModule.__mockPrisma;
      vi.clearAllMocks();

      replayPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-rotate-1',
        token: oldTokenHash,
        userId: user.id,
        family: 'family-rotate-1',
        revokedAt: new Date(Date.now() - 10_000),
        expiresAt: new Date(Date.now() + 86_400_000),
        user,
      });
      replayPrisma.refreshToken.updateMany.mockImplementation(async ({ where }: any) => {
        if (where?.userId === user.id && where?.family === 'family-rotate-1' && where?.revokedAt === null) {
          return { count: 1 };
        }
        return { count: 0 };
      });

      const replayResult = await replayService.rotateRefreshToken(oldToken);

      expect(replayResult).toBeNull();
      expect(replayPrisma.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: user.id, family: 'family-rotate-1', revokedAt: null }),
        })
      );
    });

    it('should allow only one cached recovery for a recently rotated refresh token', async () => {
      const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
      const originalRefreshToken = 'refresh-one-time-recovery';
      const originalRefreshHash = sha256(originalRefreshToken);
      const replacementToken = 'replacement-refresh-token';
      const replacementHash = sha256(replacementToken);
      const userRecord = {
        id: 'user-one-time-1',
        username: 'one-time-user',
        plan: 'free',
        planExpiresAt: null,
        emailVerified: true,
      };
      const tokenRows = new Map<
        string,
        {
          id: string;
          token: string;
          userId: string;
          family: string;
          revokedAt: Date | null;
          expiresAt: Date;
          user: typeof userRecord;
        }
      >();

      tokenRows.set(originalRefreshHash, {
        id: 'rt-one-time-old',
        token: originalRefreshHash,
        userId: userRecord.id,
        family: 'family-one-time-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
        user: userRecord,
      });

      prismaMock.refreshToken.findUnique.mockImplementation(async ({ where }: any) => {
        if (where?.token) return tokenRows.get(where.token) ?? null;
        return null;
      });
      prismaMock.refreshToken.findFirst.mockImplementation(async ({ where }: any) => {
        return (
          Array.from(tokenRows.values()).find(
            (row) =>
              row.userId === where?.userId &&
              row.family === where?.family &&
              row.revokedAt === null &&
              row.expiresAt > new Date()
          ) ?? null
        );
      });
      prismaMock.refreshToken.updateMany.mockImplementation(async ({ where, data }: any) => {
        if (where?.id === 'rt-one-time-old' && where?.revokedAt === null) {
          const row = tokenRows.get(originalRefreshHash);
          if (!row || row.revokedAt) return { count: 0 };
          row.revokedAt = data.revokedAt;
          return { count: 1 };
        }

        if (where?.userId === userRecord.id && where?.family === 'family-one-time-1' && where?.revokedAt === null) {
          let count = 0;
          for (const row of tokenRows.values()) {
            if (row.userId === where.userId && row.family === where.family && row.revokedAt === null) {
              row.revokedAt = data.revokedAt;
              count += 1;
            }
          }
          return { count };
        }

        return { count: 0 };
      });
      prismaMock.refreshToken.create.mockImplementation(async ({ data }: any) => {
        tokenRows.set(replacementHash, {
          id: 'rt-one-time-new',
          token: data.token,
          userId: data.userId,
          family: data.family,
          revokedAt: null,
          expiresAt: data.expiresAt,
          user: userRecord,
        });
        return { token: data.token };
      });

      const firstRotation = await rotateRefreshToken(originalRefreshToken);
      expect(firstRotation).not.toBeNull();

      const recoveredReplay = await rotateRefreshToken(originalRefreshToken);
      expect(recoveredReplay).not.toBeNull();
      expect(recoveredReplay!.refreshToken).toBe(firstRotation!.refreshToken);

      const secondReplay = await rotateRefreshToken(originalRefreshToken);
      expect(secondReplay).toBeNull();
      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: userRecord.id,
            family: 'family-one-time-1',
            revokedAt: null,
          }),
        })
      );
    });

    it('should not revoke the family when a loser checks before the winner settles the rotation cache', async () => {
      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((res) => {
          resolve = res;
        });
        return { promise, resolve };
      };
      const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
      const originalRefreshToken = 'refresh-race-precache-gap';
      const originalRefreshHash = sha256(originalRefreshToken);
      const userRecord = {
        id: 'user-race-gap-1',
        username: 'gapuser',
        plan: 'free',
        planExpiresAt: null,
        emailVerified: true,
      };
      const tokenRows = new Map<
        string,
        {
          id: string;
          token: string;
          userId: string;
          family: string;
          revokedAt: Date | null;
          expiresAt: Date;
          user: typeof userRecord;
        }
      >();

      tokenRows.set(originalRefreshHash, {
        id: 'rt-race-gap-1',
        token: originalRefreshHash,
        userId: userRecord.id,
        family: 'family-race-gap-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
        user: userRecord,
      });

      const winnerEnteredRevoke = deferred();
      const allowWinnerApplyRevoke = deferred();
      const winnerAppliedRevoke = deferred();
      const releaseWinnerRevoke = deferred();
      const loserEnteredRevoke = deferred();
      const loserSawCacheGap = deferred();
      const winnerStartedCreate = deferred();
      const releaseWinnerCreate = deferred();
      const familyRevokeCalls: any[] = [];
      let originalRevokeAttempts = 0;
      let replacementCreateCount = 0;

      prismaMock.refreshToken.findUnique.mockImplementation(async ({ where }: any) => {
        if (where?.token) {
          return tokenRows.get(where.token) ?? null;
        }
        if (where?.id) {
          return Array.from(tokenRows.values()).find((row) => row.id === where.id) ?? null;
        }
        return null;
      });
      prismaMock.refreshToken.findFirst.mockImplementation(async ({ where }: any) => {
        return (
          Array.from(tokenRows.values())
            .filter((row) =>
              row.userId === where?.userId &&
              row.family === where?.family &&
              row.revokedAt === null &&
              row.expiresAt > new Date()
            )
            .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0] ?? null
        );
      });
      prismaMock.refreshToken.updateMany.mockImplementation(async ({ where, data }: any) => {
        if (where?.id && Object.prototype.hasOwnProperty.call(where, 'revokedAt')) {
          const row = Array.from(tokenRows.values()).find((candidate) => candidate.id === where.id) ?? null;
          originalRevokeAttempts += 1;

          if (originalRevokeAttempts === 1) {
            winnerEnteredRevoke.resolve();
            await allowWinnerApplyRevoke.promise;

            if (!row || row.revokedAt !== null) {
              return { count: 0 };
            }

            row.revokedAt = data.revokedAt;
            winnerAppliedRevoke.resolve();
            await releaseWinnerRevoke.promise;
            return { count: 1 };
          }

          loserEnteredRevoke.resolve();
          await winnerAppliedRevoke.promise;
          loserSawCacheGap.resolve();
          if (!row || row.revokedAt !== null) {
            return { count: 0 };
          }
          return { count: 1 };
        }

        if (where?.userId && where?.family && Object.prototype.hasOwnProperty.call(where, 'revokedAt')) {
          familyRevokeCalls.push({ where, data });
          let count = 0;
          for (const row of tokenRows.values()) {
            if (row.userId === where.userId && row.family === where.family && row.revokedAt === null) {
              row.revokedAt = data.revokedAt;
              count += 1;
            }
          }
          return { count };
        }

        return { count: 0 };
      });
      prismaMock.refreshToken.create.mockImplementation(async ({ data }: any) => {
        replacementCreateCount += 1;
        winnerStartedCreate.resolve();
        await releaseWinnerCreate.promise;

        tokenRows.set(data.token, {
          id: `rt-race-gap-new-${replacementCreateCount}`,
          token: data.token,
          userId: data.userId,
          family: data.family,
          revokedAt: null,
          expiresAt: data.expiresAt,
          user: userRecord,
        });

        return { token: data.token };
      });

      const winnerPromise = rotateRefreshToken(originalRefreshToken);
      await winnerEnteredRevoke.promise;

      const loserPromise = rotateRefreshToken(originalRefreshToken);
      await loserEnteredRevoke.promise;
      allowWinnerApplyRevoke.resolve();
      await loserSawCacheGap.promise;

      await winnerAppliedRevoke.promise;
      releaseWinnerRevoke.resolve();
      await winnerStartedCreate.promise;
      releaseWinnerCreate.resolve();

      const [winnerResult, loserResult] = await Promise.all([winnerPromise, loserPromise]);

      expect(winnerResult).not.toBeNull();
      expect(loserResult).not.toBeNull();
      expect(loserResult!.refreshToken).toBe(winnerResult!.refreshToken);
      expect(familyRevokeCalls).toHaveLength(0);
    });

    it('should return null for expired refresh token', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-3',
        token: 'expired-token',
        userId: 'user-1',
        family: 'family-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 86400000), // expired yesterday
        user: { id: 'user-1', username: 'alice', emailVerified: true },
      });

      const result = await rotateRefreshToken('expired-token');
      expect(result).toBeNull();
    });
  });

  // â”€â”€ Revoke All Refresh Tokens â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('revokeAllRefreshTokens', () => {
    it('should update all non-revoked tokens for user', async () => {
      prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 2 });

      await revokeAllRefreshTokens('user-1');
      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      });
    });
  });

  describe('resetPasswordWithCode', () => {
    it('should revoke active refresh tokens during a successful password reset', async () => {
      const passwordHash = await bcrypt.hash('OldPass123', 10);
      prismaMock.user.findUnique.mockResolvedValue({ id: 'user-reset-1' });
      prismaMock.emailOtpCode.findFirst.mockResolvedValue({
        id: 'otp-1',
        userId: 'user-reset-1',
        codeHash: passwordHash,
        createdAt: new Date(Date.now() - 1_000),
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
      });
      prismaMock.emailOtpCode.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.user.update.mockResolvedValue({ id: 'user-reset-1' });
      prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 2 });

      const result = await resetPasswordWithCode('reset@example.com', 'OldPass123', 'NewPass123');

      expect(result).toEqual({ success: true, remainingAttempts: 5 });
      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-reset-1', revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      });
    });
  });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AUTH MIDDLEWARE UNIT TESTS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
describe('Auth Middleware', () => {
  function createMockReqResNext() {
    const req: any = {
      cookies: {},
      headers: {},
      params: {},
      query: {},
      body: {},
    };
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      cookie: vi.fn().mockReturnThis(),
      clearCookie: vi.fn().mockReturnThis(),
    };
    const next = vi.fn();
    return { req, res, next };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // â”€â”€ requireAuth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('requireAuth', () => {
    it('should call next() with valid token in cookie', () => {
      const { req, res, next } = createMockReqResNext();
      const token = generateTestToken(testUser);
      req.cookies = { authToken: token };

      requireAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user.userId).toBe(testUser.userId);
    });

    it('should call next() with valid token in Authorization header', () => {
      const { req, res, next } = createMockReqResNext();
      const token = generateTestToken(testUser);
      req.headers = { authorization: `Bearer ${token}` };

      requireAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user.userId).toBe(testUser.userId);
    });

    it('should return 401 when no token is present', () => {
      const { req, res, next } = createMockReqResNext();

      requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Authorization required', code: 'NO_TOKEN' })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 with code TOKEN_INVALID for wrong-secret token', () => {
      const { req, res, next } = createMockReqResNext();
      const token = generateInvalidToken(testUser);
      req.cookies = { authToken: token };

      requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'TOKEN_INVALID' })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 TOKEN_EXPIRED when expired token has refresh token (client must call /auth/refresh)', () => {
      const { req, res, next } = createMockReqResNext();
      const expiredToken = generateExpiredToken(testUser);
      req.cookies = { authToken: expiredToken, refreshToken: 'valid-refresh-tok' };

      requireAuth(req, res, next);

      // Middleware no longer does inline refresh — returns 401 for client to POST /auth/refresh
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'TOKEN_EXPIRED' })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 TOKEN_EXPIRED when expired token has no refresh token', () => {
      const { req, res, next } = createMockReqResNext();
      const expiredToken = generateExpiredToken(testUser);
      req.cookies = { authToken: expiredToken };

      requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'TOKEN_EXPIRED' })
      );
    });

    it('should prefer cookie token over Authorization header', () => {
      const { req, res, next } = createMockReqResNext();
      const cookieToken = generateTestToken({ userId: 'cookie-user', username: 'cookie' });
      const headerToken = generateTestToken({ userId: 'header-user', username: 'header' });
      req.cookies = { authToken: cookieToken };
      req.headers = { authorization: `Bearer ${headerToken}` };

      requireAuth(req, res, next);

      expect(req.user.userId).toBe('cookie-user');
    });
  });

  // â”€â”€ optionalAuth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('optionalAuth', () => {
    it('should set req.user when valid token provided', () => {
      const { req, res, next } = createMockReqResNext();
      const token = generateTestToken(testUser);
      req.cookies = { authToken: token };

      optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user.userId).toBe(testUser.userId);
    });

    it('should call next() without setting user when no token', () => {
      const { req, res, next } = createMockReqResNext();

      optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it('should call next() without user when token is expired', () => {
      const { req, res, next } = createMockReqResNext();
      const token = generateExpiredToken(testUser);
      req.cookies = { authToken: token };

      optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it('should call next() without user when token is invalid', () => {
      const { req, res, next } = createMockReqResNext();
      req.cookies = { authToken: 'garbage' };

      optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it('should continue without auth for expired tokens (client handles refresh)', () => {
      const { req, res, next } = createMockReqResNext();
      const token = generateExpiredToken(testUser);
      req.cookies = { authToken: token };

      optionalAuth(req, res, next);

      // Expired tokens: continue without auth, don't clear cookies (refresh token may be valid)
      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
      expect(res.clearCookie).not.toHaveBeenCalled();
    });
  });

  // â”€â”€ requireOwnership â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('requireOwnership', () => {
    it('should call next() when user owns the resource (params)', () => {
      const { req, res, next } = createMockReqResNext();
      req.user = { userId: 'user-1', username: 'alice' };
      req.params = { userId: 'user-1' };

      const mw = requireOwnership();
      mw(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should return 403 when user does not own the resource', () => {
      const { req, res, next } = createMockReqResNext();
      req.user = { userId: 'user-1', username: 'alice' };
      req.params = { userId: 'user-2' };

      const mw = requireOwnership();
      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when no user is set', () => {
      const { req, res, next } = createMockReqResNext();

      const mw = requireOwnership();
      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 400 when no userId param is present (fail-closed)', () => {
      const { req, res, next } = createMockReqResNext();
      req.user = { userId: 'user-1', username: 'alice' };

      const mw = requireOwnership();
      mw(req, res, next);

      // Hardened: fail-closed when userId param is missing (never falls back to query/body)
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it('should check custom param name', () => {
      const { req, res, next } = createMockReqResNext();
      req.user = { userId: 'user-1', username: 'alice' };
      req.params = { ownerId: 'user-1' };

      const mw = requireOwnership('ownerId');
      mw(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should ignore userId from query string (only checks route params)', () => {
      const { req, res, next } = createMockReqResNext();
      req.user = { userId: 'user-1', username: 'alice' };
      req.query = { userId: 'user-2' };

      const mw = requireOwnership();
      mw(req, res, next);

      // Hardened: never falls back to query/body — returns 400 for missing param
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it('should ignore userId from body (only checks route params)', () => {
      const { req, res, next } = createMockReqResNext();
      req.user = { userId: 'user-1', username: 'alice' };
      req.body = { userId: 'user-1' };

      const mw = requireOwnership();
      mw(req, res, next);

      // Hardened: never falls back to query/body — returns 400 for missing param
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });
  });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AUTH ROUTES INTEGRATION TESTS (supertest)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
describe('Auth Routes (Integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no MFA enabled
    prismaMock.mfaMethod.count.mockResolvedValue(0);
    // Default: no grace-period token
    prismaMock.refreshToken.findFirst.mockResolvedValue(null);
    // Default: no Plaid items (for delete-account)
    prismaMock.plaidItem.findMany.mockResolvedValue([]);
    // Default: no existing user in case-insensitive username lookup
    (prismaMock as any).$queryRaw.mockResolvedValue([]);
    // Default: waitlist not blocking signup
    (prismaMock as any).waitlist.findUnique.mockResolvedValue({ status: 'approved' });
  });

  // â”€â”€ POST /auth/login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('POST /auth/login', () => {
    it('should return 200 and set cookies on successful login', async () => {
      const hash = await bcrypt.hash('ValidPass1', 10);
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        username: 'alice',
        displayName: 'Alice',
        passwordHash: hash,
      });
      prismaMock.refreshToken.create.mockResolvedValue({ token: 'rt-1' });

      const res = await request(app)
        .post('/auth/login')
        .set('Origin', 'http://localhost:5173')
        .send({ username: 'alice', password: 'ValidPass1' });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe('alice');
      // Tokens are only in response body for native (Capacitor) clients;
      // web clients receive them via httpOnly cookies only.
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
      // Check that cookies are set
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies;
      expect(cookieStr).toContain('authToken');
    });

    it('should return 401 for invalid credentials', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/auth/login')
        .set('Origin', 'http://localhost:5173')
        .send({ username: 'nobody', password: 'SomePass1' });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid');
    });

    it('should return 400 when username is missing', async () => {
      const res = await request(app)
        .post('/auth/login')
        .set('Origin', 'http://localhost:5173')
        .send({ password: 'SomePass1' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when password is missing', async () => {
      const res = await request(app)
        .post('/auth/login')
        .set('Origin', 'http://localhost:5173')
        .send({ username: 'alice' });

      expect(res.status).toBe(400);
    });
  });

  // â”€â”€ POST /auth/logout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('POST /auth/logout', () => {
    it('should return 200 and clear cookies', async () => {
      const res = await request(app)
        .post('/auth/logout')
        .set('Origin', 'http://localhost:5173');

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Logged out');
    });
  });

  // â”€â”€ GET /auth/me â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('GET /auth/me', () => {
    it('should return user data for authenticated request', async () => {
      const token = generateTestToken(testUser);
      prismaMock.user.findUnique.mockResolvedValue({
        id: testUser.userId,
        username: testUser.username,
        displayName: 'Test User',
      });

      const res = await request(app)
        .get('/auth/me')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(200);
      expect(res.body.username).toBe(testUser.username);
    });

    it('should return 401 for unauthenticated request', async () => {
      const res = await request(app).get('/auth/me');

      expect(res.status).toBe(401);
    });

    it('should return 404 when user no longer exists', async () => {
      const token = generateTestToken(testUser);
      prismaMock.user.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get('/auth/me')
        .set('Cookie', `authToken=${token}`);

      expect(res.status).toBe(404);
    });
  });

  // â”€â”€ POST /auth/signup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('POST /auth/signup', () => {
    it('should return 201 and set cookies on successful signup', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null); // username check + email check
      prismaMock.user.create.mockResolvedValue({
        id: 'new-id',
        username: 'newuser',
        displayName: 'New User',
        email: 'newuser@example.com',
        emailVerified: false,
        plan: 'free',
        planExpiresAt: null,
      });
      prismaMock.userSettings.create.mockResolvedValue({});
      prismaMock.consentRecord.create.mockResolvedValue({});
      prismaMock.emailOtpCode.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.emailOtpCode.create.mockResolvedValue({});
      prismaMock.refreshToken.create.mockResolvedValue({ token: 'rt-new' });

      const res = await request(app)
        .post('/auth/signup')
        .set('Origin', 'http://localhost:5173')
        .send({
          username: 'newuser',
          email: 'newuser@example.com',
          displayName: 'New User',
          password: 'StrongPass1',
          acceptedPrivacyPolicy: true,
          acceptedTerms: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.user.username).toBe('newuser');
      // Tokens are only in response body for native (Capacitor) clients;
      // web clients receive them via httpOnly cookies only.
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
    });

    it('should return 400 for invalid username format', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .set('Origin', 'http://localhost:5173')
        .send({ username: 'ab', email: 'valid@example.com', displayName: 'Name', password: 'StrongPass1', acceptedPrivacyPolicy: true, acceptedTerms: true });

      expect(res.status).toBe(400);
    });

    it('should return 400 for weak password (no uppercase)', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .set('Origin', 'http://localhost:5173')
        .send({ username: 'validuser', email: 'valid@example.com', displayName: 'Name', password: 'weakpass1', acceptedPrivacyPolicy: true, acceptedTerms: true });

      expect(res.status).toBe(400);
    });

    it('should return 400 for short password', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .set('Origin', 'http://localhost:5173')
        .send({ username: 'validuser', email: 'valid@example.com', displayName: 'Name', password: 'Sh1', acceptedPrivacyPolicy: true, acceptedTerms: true });

      expect(res.status).toBe(400);
    });

    it('should return 409 for duplicate username', async () => {
      // usernameExists now uses case-insensitive $queryRaw
      (prismaMock as any).$queryRaw.mockResolvedValue([{ id: 'existing-id' }]);

      const res = await request(app)
        .post('/auth/signup')
        .set('Origin', 'http://localhost:5173')
        .send({ username: 'taken_user', email: 'taken@example.com', displayName: 'Name', password: 'StrongPass1', acceptedPrivacyPolicy: true, acceptedTerms: true });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already taken');
    });

    it('should return 400 when display name is missing', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .set('Origin', 'http://localhost:5173')
        .send({ username: 'validuser', email: 'valid@example.com', password: 'StrongPass1', acceptedPrivacyPolicy: true, acceptedTerms: true });

      expect(res.status).toBe(400);
    });
  });

  // â”€â”€ POST /auth/set-password â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('POST /auth/set-password', () => {
    it('should set password successfully', async () => {
      const token = generateTestToken(testUser);
      prismaMock.user.updateMany.mockResolvedValue({ count: 1 });

      const res = await request(app)
        .post('/auth/set-password')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .send({ password: 'NewPass123' });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Password set');
    });

    it('should return 400 when user already has a password', async () => {
      const token = generateTestToken(testUser);
      prismaMock.user.updateMany.mockResolvedValue({ count: 0 });

      const res = await request(app)
        .post('/auth/set-password')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .send({ password: 'NewPass123' });

      expect(res.status).toBe(400);
    });

    it('should return 400 for weak password', async () => {
      const token = generateTestToken(testUser);

      const res = await request(app)
        .post('/auth/set-password')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .send({ password: 'weak' });

      expect(res.status).toBe(400);
    });

    it('should return 400 for password without numbers', async () => {
      const token = generateTestToken(testUser);

      const res = await request(app)
        .post('/auth/set-password')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .send({ password: 'NoNumbersHere' });

      expect(res.status).toBe(400);
    });
  });

  // â”€â”€ POST /auth/change-password â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('POST /auth/change-password', () => {
    it('should change password for authenticated user', async () => {
      const token = generateTestToken(testUser);
      const hash = await bcrypt.hash('OldPass1', 10);
      prismaMock.user.findUnique.mockResolvedValue({ passwordHash: hash });
      prismaMock.user.update.mockResolvedValue({});

      const res = await request(app)
        .post('/auth/change-password')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .send({ currentPassword: 'OldPass1', newPassword: 'NewPass123' });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Password changed');
    });

    it('should return 400 for wrong current password', async () => {
      const token = generateTestToken(testUser);
      const hash = await bcrypt.hash('OldPass1', 10);
      prismaMock.user.findUnique.mockResolvedValue({ passwordHash: hash });

      const res = await request(app)
        .post('/auth/change-password')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .send({ currentPassword: 'WrongPass1', newPassword: 'NewPass123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('incorrect');
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .post('/auth/change-password')
        .set('Origin', 'http://localhost:5173')
        .send({ currentPassword: 'Old1', newPassword: 'New1Pass' });

      expect(res.status).toBe(401);
    });

    it('should return 400 for weak new password', async () => {
      const token = generateTestToken(testUser);

      const res = await request(app)
        .post('/auth/change-password')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .send({ currentPassword: 'OldPass1', newPassword: 'weak' });

      expect(res.status).toBe(400);
    });
  });

  // â”€â”€ DELETE /auth/delete-account â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('DELETE /auth/delete-account', () => {
    it('should delete account with correct password', async () => {
      const token = generateTestToken(testUser);
      const hash = await bcrypt.hash('MyPass1', 10);
      prismaMock.user.findUnique.mockResolvedValue({
        id: testUser.userId,
        passwordHash: hash,
      });
      // Default $transaction passes mockPrisma as tx — all models are present

      const res = await request(app)
        .delete('/auth/delete-account')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .send({ password: 'MyPass1' });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('deleted');
    });

    it('should return 401 for incorrect password', async () => {
      const token = generateTestToken(testUser);
      const hash = await bcrypt.hash('CorrectPass1', 10);
      prismaMock.user.findUnique.mockResolvedValue({
        id: testUser.userId,
        passwordHash: hash,
      });

      const res = await request(app)
        .delete('/auth/delete-account')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .send({ password: 'WrongPass1' });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Incorrect');
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .delete('/auth/delete-account')
        .set('Origin', 'http://localhost:5173')
        .send({ password: 'Pass1234' });

      expect(res.status).toBe(401);
    });

    it('should return 400 when password not provided', async () => {
      const token = generateTestToken(testUser);

      const res = await request(app)
        .delete('/auth/delete-account')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // â”€â”€ GET /auth/check-username/:username â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('GET /auth/check-username/:username', () => {
    it('should return available: true for unused username', async () => {
      (prismaMock as any).$queryRaw.mockResolvedValue([]);

      const res = await request(app).get('/auth/check-username/newname');

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
    });

    it('should return available: false for taken username', async () => {
      (prismaMock as any).$queryRaw.mockResolvedValue([{ id: 'u1' }]);

      const res = await request(app).get('/auth/check-username/alice');

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(false);
    });
  });

  // â”€â”€ GET /auth/has-password/:username â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('GET /auth/has-password/:username', () => {
    it('should return hasPassword: true when password is set', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ passwordHash: '$2a$...' });

      const res = await request(app).get('/auth/has-password/alice');

      expect(res.status).toBe(200);
      expect(res.body.hasPassword).toBe(true);
    });

    it('should always return hasPassword: true to prevent auth-type enumeration', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ passwordHash: null });

      const res = await request(app).get('/auth/has-password/bob');

      expect(res.status).toBe(200);
      // Always returns true — prevents attackers from determining if an account uses password auth
      expect(res.body.hasPassword).toBe(true);
    });
  });

  // â”€â”€ POST /auth/refresh â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('POST /auth/refresh', () => {
    it('should rotate tokens and set new cookies', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        token: 'valid-refresh',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
        user: { id: 'user-1', username: 'alice', emailVerified: true },
      });
      prismaMock.refreshToken.update.mockResolvedValue({});
      prismaMock.refreshToken.create.mockResolvedValue({ token: 'new-refresh' });

      const res = await request(app)
        .post('/auth/refresh')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', 'refreshToken=valid-refresh');

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('refreshed');
      // Tokens are only in response body for native (Capacitor) clients;
      // web clients receive them via httpOnly cookies only.
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies;
      expect(cookieStr).toContain('authToken');
    });

    it('should return 401 when no refresh token provided', async () => {
      const res = await request(app)
        .post('/auth/refresh')
        .set('Origin', 'http://localhost:5173');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('NO_TOKEN');
    });

    it('should return 401 for invalid refresh token', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/auth/refresh')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', 'refreshToken=invalid-token');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });

    it('should clear auth cookies when the refresh token does not exist', async () => {
      prismaMock.refreshToken.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/auth/refresh')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', ['authToken=stale-access', 'refreshToken=missing-refresh']);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies;
      expect(cookieStr).toContain('authToken=');
      expect(cookieStr).toContain('refreshToken=');
    });

    it('should allow two concurrent refreshes on the same token without revoking the family', async () => {
      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((res) => {
          resolve = res;
        });
        return { promise, resolve };
      };
      const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
      const originalRefreshToken = 'refresh-race-original';
      const originalRefreshHash = sha256(originalRefreshToken);
      const userRecord = {
        id: 'user-race-1',
        username: 'raceuser',
        plan: 'free',
        planExpiresAt: null,
        emailVerified: true,
      };
      const tokenRows = new Map<
        string,
        {
          id: string;
          token: string;
          userId: string;
          family: string;
          revokedAt: Date | null;
          replacedByTokenId: string | null;
          expiresAt: Date;
          user: typeof userRecord;
        }
      >();

      tokenRows.set(originalRefreshHash, {
        id: 'rt-race-1',
        token: originalRefreshHash,
        userId: userRecord.id,
        family: 'family-race-1',
        revokedAt: null,
        replacedByTokenId: null,
        expiresAt: new Date(Date.now() + 86400000),
        user: userRecord,
      });

      const blockedFirstRevoke = deferred();
      const secondRevokeReached = deferred();
      const replacementCreated = deferred();
      const observedRevokedStates: Array<Date | null> = [];
      let originalRevokeAttempts = 0;
      let replacementCreateCount = 0;

      prismaMock.refreshToken.findUnique.mockImplementation(async ({ where }: any) => {
        if (where?.token) {
          const row = tokenRows.get(where.token) ?? null;
          if (where.token === originalRefreshHash && row) {
            observedRevokedStates.push(row.revokedAt);
          }
          return row;
        }
        if (where?.id) {
          return Array.from(tokenRows.values()).find((row) => row.id === where.id) ?? null;
        }
        return null;
      });
      prismaMock.refreshToken.findFirst.mockImplementation(async ({ where }: any) => {
        return (
          Array.from(tokenRows.values())
            .filter((row) =>
              row.userId === where?.userId &&
              row.family === where?.family &&
              row.revokedAt === null &&
              row.expiresAt > new Date()
            )
            .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0] ?? null
        );
      });

      prismaMock.refreshToken.updateMany.mockImplementation(async ({ where, data }: any) => {
        if (where?.id && Object.prototype.hasOwnProperty.call(where, 'revokedAt')) {
          const row = Array.from(tokenRows.values()).find((candidate) => candidate.id === where.id) ?? null;
          originalRevokeAttempts += 1;

          if (originalRevokeAttempts === 1) {
            await secondRevokeReached.promise;
            await blockedFirstRevoke.promise;
          } else {
            secondRevokeReached.resolve();
          }

          if (!row || row.revokedAt !== null) {
            return { count: 0 };
          }

          row.revokedAt = data.revokedAt;
          return { count: 1 };
        }

        if (where?.userId && where?.family && Object.prototype.hasOwnProperty.call(where, 'revokedAt')) {
          let count = 0;
          for (const row of tokenRows.values()) {
            if (row.userId === where.userId && row.family === where.family && row.revokedAt === null) {
              row.revokedAt = data.revokedAt;
              count += 1;
            }
          }
          return { count };
        }

        return { count: 0 };
      });

      prismaMock.refreshToken.create.mockImplementation(async ({ data }: any) => {
        replacementCreateCount += 1;
        const replacementRow = {
          id: `rt-race-${tokenRows.size + 1}`,
          token: data.token,
          userId: data.userId,
          family: data.family,
          revokedAt: null,
          replacedByTokenId: null,
          expiresAt: data.expiresAt,
          user: userRecord,
        };
        const originalRow = tokenRows.get(originalRefreshHash);
        if (originalRow && !originalRow.replacedByTokenId) {
          originalRow.replacedByTokenId = replacementRow.id;
        }
        tokenRows.set(replacementRow.token, replacementRow);
        replacementCreated.resolve();
        return replacementRow;
      });

      prismaMock.user.findUnique.mockImplementation(async ({ where }: any) => {
        if (where?.id === userRecord.id) {
          return {
            id: userRecord.id,
            username: userRecord.username,
            displayName: 'Race User',
            emailVerified: true,
          };
        }
        return null;
      });

      const firstRefreshPromise = request(app)
          .post('/auth/refresh')
          .set('Origin', 'capacitor://localhost')
          .set('X-Nala-Native', '1')
          .set('Cookie', `refreshToken=${originalRefreshToken}`)
          .then((res) => res);
      const secondRefreshPromise = request(app)
          .post('/auth/refresh')
          .set('Origin', 'capacitor://localhost')
          .set('X-Nala-Native', '1')
          .set('Cookie', `refreshToken=${originalRefreshToken}`)
          .then((res) => res);

      await secondRevokeReached.promise;
      await replacementCreated.promise;
      blockedFirstRevoke.resolve();

      const [firstRes, secondRes] = await Promise.all([firstRefreshPromise, secondRefreshPromise]);

      expect(firstRes.status).toBe(200);
      expect(secondRes.status).toBe(200);
      expect(firstRes.body.accessToken).toEqual(expect.any(String));
      expect(secondRes.body.accessToken).toEqual(expect.any(String));
      expect(firstRes.body.refreshToken).toEqual(expect.any(String));
      expect(secondRes.body.refreshToken).toEqual(expect.any(String));
      expect(secondRes.body.refreshToken).toBe(firstRes.body.refreshToken);
      expect(observedRevokedStates).toEqual([null, null]);
      expect(originalRevokeAttempts).toBe(2);
      expect(replacementCreateCount).toBe(1);

      const familyRows = Array.from(tokenRows.values()).filter((row) => row.family === 'family-race-1');
      expect(familyRows.some((row) => row.revokedAt === null)).toBe(true);

      const meWithFirstAccessToken = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${firstRes.body.accessToken}`);
      expect(meWithFirstAccessToken.status).toBe(200);

      const meWithSecondAccessToken = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${secondRes.body.accessToken}`);
      expect(meWithSecondAccessToken.status).toBe(200);

      const followupRefresh = await request(app)
        .post('/auth/refresh')
        .set('Origin', 'capacitor://localhost')
        .set('X-Nala-Native', '1')
        .set('Cookie', `refreshToken=${firstRes.body.refreshToken}`);

      expect(followupRefresh.status).toBe(200);
      expect(followupRefresh.body.accessToken).toEqual(expect.any(String));
      expect(followupRefresh.body.refreshToken).toEqual(expect.any(String));
    });
  });

  // â”€â”€ POST /auth/change-password (revokes refresh tokens) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('POST /auth/change-password (token revocation)', () => {
    it('should revoke all refresh tokens after successful password change', async () => {
      const token = generateTestToken(testUser);
      const hash = await bcrypt.hash('OldPass1', 10);
      prismaMock.user.findUnique.mockResolvedValue({ passwordHash: hash });
      prismaMock.user.update.mockResolvedValue({});
      prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 2 });

      const res = await request(app)
        .post('/auth/change-password')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `authToken=${token}`)
        .send({ currentPassword: 'OldPass1', newPassword: 'NewPass123' });

      expect(res.status).toBe(200);
      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: testUser.userId, revokedAt: null }),
        })
      );
    });
  });
});

