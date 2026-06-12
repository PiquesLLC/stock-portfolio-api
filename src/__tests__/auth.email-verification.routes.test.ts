import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { generateTestToken, testUser, TEST_EMAIL } from './helpers';

vi.mock('../middleware/rateLimiter', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const passthrough = (_req: any, _res: any, next: any) => next();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? passthrough : v]),
  );
});

import app from '../app';
import * as authService from '../services/auth.service';

describe('Email verification routes', () => {
  let authCookie: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // Generate auth cookie for requireAuthAllowUnverified on /verify-email
    const token = generateTestToken({ ...testUser, emailVerified: false });
    authCookie = `authToken=${token}`;
    // Mock getUserById so controller can resolve email from authenticated user
    vi.spyOn(authService, 'getUserById').mockResolvedValue({
      id: testUser.userId,
      username: testUser.username,
      displayName: 'Test User',
      email: TEST_EMAIL,
      emailVerified: false,
      plan: 'free',
      planExpiresAt: null,
      createdAt: new Date(),
    });
  });

  describe('POST /auth/verify-email', () => {
    it('returns 200 for valid code', async () => {
      vi.spyOn(authService, 'verifyEmailCode').mockResolvedValue({
        success: true,
        remainingAttempts: 5,
      });

      const res = await request(app)
        .post('/auth/verify-email')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', authCookie)
        .send({ code: '123456' });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Email verified');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/auth/verify-email')
        .send({ code: '123456' });

      expect(res.status).toBe(401);
    });

    it('returns 400 for invalid code format', async () => {
      const res = await request(app)
        .post('/auth/verify-email')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', authCookie)
        .send({ code: 'abc' });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid code with remaining attempts', async () => {
      vi.spyOn(authService, 'verifyEmailCode').mockResolvedValue({
        success: false,
        remainingAttempts: 2,
        error: 'INVALID_OR_EXPIRED',
      });

      const res = await request(app)
        .post('/auth/verify-email')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', authCookie)
        .send({ code: '999999' });

      expect(res.status).toBe(400);
      expect(res.body.remainingAttempts).toBe(2);
    });

    it('returns 429 for too many attempts', async () => {
      vi.spyOn(authService, 'verifyEmailCode').mockResolvedValue({
        success: false,
        remainingAttempts: 0,
        error: 'TOO_MANY_ATTEMPTS',
      });

      const res = await request(app)
        .post('/auth/verify-email')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', authCookie)
        .send({ code: '111111' });

      expect(res.status).toBe(429);
    });

    it('uses authenticated user email, not body email', async () => {
      const spy = vi.spyOn(authService, 'verifyEmailCode').mockResolvedValue({
        success: true,
        remainingAttempts: 5,
      });

      await request(app)
        .post('/auth/verify-email')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', authCookie)
        .send({ email: 'attacker@evil.com', code: '123456' });

      // Should have called verifyEmailCode with the DB user's email, not the body email
      expect(spy).toHaveBeenCalledWith(TEST_EMAIL, '123456');
    });
  });

  describe('POST /auth/resend-verification', () => {
    it('returns 200 for resend success', async () => {
      vi.spyOn(authService, 'resendVerificationEmail').mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/auth/resend-verification')
        .send({ email: TEST_EMAIL });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('verification code');
    });

    // L4: the response must NOT vary with account state, or it enumerates users.
    it('returns the same generic 200 when the per-account resend cap is hit (no enumeration)', async () => {
      vi.spyOn(authService, 'resendVerificationEmail').mockResolvedValue({
        success: false,
        error: 'RATE_LIMIT',
      });

      const res = await request(app)
        .post('/auth/resend-verification')
        .send({ email: TEST_EMAIL });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('If this email is registered');
    });

    it('returns the same generic 200 when the email is already verified (no enumeration)', async () => {
      vi.spyOn(authService, 'resendVerificationEmail').mockResolvedValue({
        success: false,
        error: 'ALREADY_VERIFIED',
      });

      const res = await request(app)
        .post('/auth/resend-verification')
        .send({ email: TEST_EMAIL });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('If this email is registered');
    });
  });
});
