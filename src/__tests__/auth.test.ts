import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { generateTestToken, generateExpiredToken, generateInvalidToken, testUser } from './helpers';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// Rate Limiter Mock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Disable rate limiters in tests
vi.mock('../middleware/rateLimiter', () => {
  const passthrough = (req: any, res: any, next: any) => next();
  return {
    loginLimiter: passthrough,
    setPasswordLimiter: passthrough,
    signupLimiter: passthrough,
    mutationLimiter: passthrough,
    heavyReadLimiter: passthrough,
    apiLimiter: passthrough,
  };
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
      });
      prismaMock.userSettings.create.mockResolvedValue({});
      prismaMock.refreshToken.create.mockResolvedValue({ token: 'refresh-tok' });

      const result = await signup('newuser', 'New User', 'StrongPass1');

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
      const result = await signup('taken', 'Taken User', 'StrongPass1');
      expect(result).toBeNull();
    });
  });

  // â”€â”€ Set Password â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('setPassword', () => {
    it('should update password and return true', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', username: 'alice' });
      prismaMock.user.update.mockResolvedValue({});

      const result = await setPassword('alice', 'NewPass123');
      expect(result).toBe(true);
      expect(prismaMock.user.update).toHaveBeenCalled();
    });

    it('should return false for non-existent user', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
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
      prismaMock.user.findUnique.mockResolvedValue({ id: 'u1' });
      expect(await usernameExists('alice')).toBe(true);
    });

    it('should return false for unknown username', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      expect(await usernameExists('ghost')).toBe(false);
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
  });

  // â”€â”€ Refresh Token Rotation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('rotateRefreshToken', () => {
    it('should return new tokens for a valid refresh token', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        token: 'old-token',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
        user: { id: 'user-1', username: 'alice' },
      });
      prismaMock.refreshToken.update.mockResolvedValue({});
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

    it('should return null and revoke family if token was already revoked', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-2',
        token: 'revoked-token',
        userId: 'user-1',
        revokedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 86400000),
        user: { id: 'user-1', username: 'alice' },
      });
      prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 3 });

      const result = await rotateRefreshToken('revoked-token');
      expect(result).toBeNull();
      expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1', revokedAt: null }),
        })
      );
    });

    it('should return null without revoking family if token was recently revoked', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-2b',
        token: 'revoked-token-recent',
        userId: 'user-1',
        revokedAt: new Date(Date.now() - 5_000),
        expiresAt: new Date(Date.now() + 86400000),
        user: { id: 'user-1', username: 'alice' },
      });

      const result = await rotateRefreshToken('revoked-token-recent');
      expect(result).toBeNull();
      expect(prismaMock.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('should return null for expired refresh token', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-3',
        token: 'expired-token',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 86400000), // expired yesterday
        user: { id: 'user-1', username: 'alice' },
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

    it('should attempt refresh when access token is expired and refresh token exists', async () => {
      const { req, res, next } = createMockReqResNext();
      const expiredToken = generateExpiredToken(testUser);
      req.cookies = { authToken: expiredToken, refreshToken: 'valid-refresh-tok' };

      // Mock the rotateRefreshToken to succeed
      prismaMock.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        token: 'valid-refresh-tok',
        userId: testUser.userId,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
        user: { id: testUser.userId, username: testUser.username },
      });
      prismaMock.refreshToken.update.mockResolvedValue({});
      prismaMock.refreshToken.create.mockResolvedValue({ token: 'new-refresh' });

      requireAuth(req, res, next);

      // requireAuth with expired token + refresh is async, need to wait
      await vi.waitFor(() => {
        expect(next).toHaveBeenCalled();
      }, { timeout: 2000 });

      expect(res.cookie).toHaveBeenCalledWith('authToken', expect.any(String), expect.any(Object));
      expect(res.cookie).toHaveBeenCalledWith('refreshToken', expect.any(String), expect.any(Object));
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

    it('should clear cookies for expired tokens', () => {
      const { req, res, next } = createMockReqResNext();
      const token = generateExpiredToken(testUser);
      req.cookies = { authToken: token };

      optionalAuth(req, res, next);

      expect(res.clearCookie).toHaveBeenCalled();
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

    it('should call next() when no userId is in params/query/body (defaults to own user)', () => {
      const { req, res, next } = createMockReqResNext();
      req.user = { userId: 'user-1', username: 'alice' };

      const mw = requireOwnership();
      mw(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should check custom param name', () => {
      const { req, res, next } = createMockReqResNext();
      req.user = { userId: 'user-1', username: 'alice' };
      req.params = { ownerId: 'user-1' };

      const mw = requireOwnership('ownerId');
      mw(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should check userId from query string', () => {
      const { req, res, next } = createMockReqResNext();
      req.user = { userId: 'user-1', username: 'alice' };
      req.query = { userId: 'user-2' };

      const mw = requireOwnership();
      mw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should check userId from body', () => {
      const { req, res, next } = createMockReqResNext();
      req.user = { userId: 'user-1', username: 'alice' };
      req.body = { userId: 'user-1' };

      const mw = requireOwnership();
      mw(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AUTH ROUTES INTEGRATION TESTS (supertest)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
describe('Auth Routes (Integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        .send({ username: 'alice', password: 'ValidPass1' });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe('alice');
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
        .send({ username: 'nobody', password: 'SomePass1' });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid');
    });

    it('should return 400 when username is missing', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ password: 'SomePass1' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when password is missing', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ username: 'alice' });

      expect(res.status).toBe(400);
    });
  });

  // â”€â”€ POST /auth/logout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('POST /auth/logout', () => {
    it('should return 200 and clear cookies', async () => {
      const res = await request(app).post('/auth/logout');

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
      prismaMock.user.findUnique.mockResolvedValue(null); // username check + signup check
      prismaMock.user.create.mockResolvedValue({
        id: 'new-id',
        username: 'newuser',
        displayName: 'New User',
      });
      prismaMock.userSettings.create.mockResolvedValue({});
      prismaMock.refreshToken.create.mockResolvedValue({ token: 'rt-new' });

      const res = await request(app)
        .post('/auth/signup')
        .send({ username: 'newuser', displayName: 'New User', password: 'StrongPass1' });

      expect(res.status).toBe(201);
      expect(res.body.user.username).toBe('newuser');
    });

    it('should return 400 for invalid username format', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .send({ username: 'ab', displayName: 'Name', password: 'StrongPass1' });

      expect(res.status).toBe(400);
    });

    it('should return 400 for weak password (no uppercase)', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .send({ username: 'validuser', displayName: 'Name', password: 'weakpass1' });

      expect(res.status).toBe(400);
    });

    it('should return 400 for short password', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .send({ username: 'validuser', displayName: 'Name', password: 'Sh1' });

      expect(res.status).toBe(400);
    });

    it('should return 409 for duplicate username', async () => {
      // First findUnique for usernameExists check
      prismaMock.user.findUnique.mockResolvedValue({ id: 'existing-id' });

      const res = await request(app)
        .post('/auth/signup')
        .send({ username: 'taken_user', displayName: 'Name', password: 'StrongPass1' });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already taken');
    });

    it('should return 400 when display name is missing', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .send({ username: 'validuser', password: 'StrongPass1' });

      expect(res.status).toBe(400);
    });
  });

  // â”€â”€ POST /auth/set-password â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('POST /auth/set-password', () => {
    it('should set password successfully', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', username: 'alice' });
      prismaMock.user.update.mockResolvedValue({});

      const res = await request(app)
        .post('/auth/set-password')
        .send({ username: 'alice', password: 'NewPass123' });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Password set');
    });

    it('should return 404 for non-existent user', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/auth/set-password')
        .send({ username: 'ghost', password: 'NewPass123' });

      expect(res.status).toBe(404);
    });

    it('should return 400 for weak password', async () => {
      const res = await request(app)
        .post('/auth/set-password')
        .send({ username: 'alice', password: 'weak' });

      expect(res.status).toBe(400);
    });

    it('should return 400 for password without numbers', async () => {
      const res = await request(app)
        .post('/auth/set-password')
        .send({ username: 'alice', password: 'NoNumbersHere' });

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
        .set('Cookie', `authToken=${token}`)
        .send({ currentPassword: 'WrongPass1', newPassword: 'NewPass123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('incorrect');
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .post('/auth/change-password')
        .send({ currentPassword: 'Old1', newPassword: 'New1Pass' });

      expect(res.status).toBe(401);
    });

    it('should return 400 for weak new password', async () => {
      const token = generateTestToken(testUser);

      const res = await request(app)
        .post('/auth/change-password')
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
      prismaMock.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          refreshToken: { deleteMany: vi.fn() },
          activityEvent: { deleteMany: vi.fn() },
          follow: { deleteMany: vi.fn() },
          alertEvent: { deleteMany: vi.fn() },
          alert: { deleteMany: vi.fn() },
          holding: { deleteMany: vi.fn() },
          portfolioSnapshot: { deleteMany: vi.fn() },
          userSettings: { deleteMany: vi.fn() },
          user: { delete: vi.fn() },
        };
        await fn(tx);
      });

      const res = await request(app)
        .delete('/auth/delete-account')
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
        .set('Cookie', `authToken=${token}`)
        .send({ password: 'WrongPass1' });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Incorrect');
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .delete('/auth/delete-account')
        .send({ password: 'Pass1234' });

      expect(res.status).toBe(401);
    });

    it('should return 400 when password not provided', async () => {
      const token = generateTestToken(testUser);

      const res = await request(app)
        .delete('/auth/delete-account')
        .set('Cookie', `authToken=${token}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // â”€â”€ GET /auth/check-username/:username â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('GET /auth/check-username/:username', () => {
    it('should return available: true for unused username', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      const res = await request(app).get('/auth/check-username/newname');

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
    });

    it('should return available: false for taken username', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ id: 'u1' });

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

    it('should return hasPassword: false when no password', async () => {
      prismaMock.user.findUnique.mockResolvedValue({ passwordHash: null });

      const res = await request(app).get('/auth/has-password/bob');

      expect(res.status).toBe(200);
      expect(res.body.hasPassword).toBe(false);
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
        user: { id: 'user-1', username: 'alice' },
      });
      prismaMock.refreshToken.update.mockResolvedValue({});
      prismaMock.refreshToken.create.mockResolvedValue({ token: 'new-refresh' });

      const res = await request(app)
        .post('/auth/refresh')
        .set('Cookie', 'refreshToken=valid-refresh');

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('refreshed');
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies;
      expect(cookieStr).toContain('authToken');
    });

    it('should return 401 when no refresh token provided', async () => {
      const res = await request(app).post('/auth/refresh');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('NO_TOKEN');
    });

    it('should return 401 for invalid refresh token', async () => {
      prismaMock.refreshToken.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/auth/refresh')
        .set('Cookie', 'refreshToken=invalid-token');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
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

