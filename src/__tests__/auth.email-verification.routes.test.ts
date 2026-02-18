import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../middleware/rateLimiter', async () => {
  const actual = await vi.importActual<typeof import('../middleware/rateLimiter')>('../middleware/rateLimiter');
  const passthrough = (req: any, res: any, next: any) => next();
  return {
    ...actual,
    loginLimiter: passthrough,
    mfaVerifyLimiter: passthrough,
    mfaSendLimiter: passthrough,
    setPasswordLimiter: passthrough,
    signupLimiter: passthrough,
    mutationLimiter: passthrough,
    heavyReadLimiter: passthrough,
    apiLimiter: passthrough,
    enumerationLimiter: passthrough,
  };
});

import app from '../app';
import * as authService from '../services/auth.service';

describe('Email verification routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /auth/verify-email', () => {
    it('returns 200 for valid code', async () => {
      vi.spyOn(authService, 'verifyEmailCode').mockResolvedValue({
        success: true,
        remainingAttempts: 5,
      });

      const res = await request(app)
        .post('/auth/verify-email')
        .send({ email: 'test@example.com', code: '123456' });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Email verified');
    });

    it('returns 400 for invalid code with remaining attempts', async () => {
      vi.spyOn(authService, 'verifyEmailCode').mockResolvedValue({
        success: false,
        remainingAttempts: 2,
        error: 'INVALID_OR_EXPIRED',
      });

      const res = await request(app)
        .post('/auth/verify-email')
        .send({ email: 'test@example.com', code: '999999' });

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
        .send({ email: 'test@example.com', code: '111111' });

      expect(res.status).toBe(429);
    });
  });

  describe('POST /auth/resend-verification', () => {
    it('returns 200 for resend success', async () => {
      vi.spyOn(authService, 'resendVerificationEmail').mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/auth/resend-verification')
        .send({ email: 'test@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('verification code');
    });

    it('returns 429 when resend is rate limited', async () => {
      vi.spyOn(authService, 'resendVerificationEmail').mockResolvedValue({
        success: false,
        error: 'RATE_LIMIT',
      });

      const res = await request(app)
        .post('/auth/resend-verification')
        .send({ email: 'test@example.com' });

      expect(res.status).toBe(429);
    });

    it('returns 400 when email is already verified', async () => {
      vi.spyOn(authService, 'resendVerificationEmail').mockResolvedValue({
        success: false,
        error: 'ALREADY_VERIFIED',
      });

      const res = await request(app)
        .post('/auth/resend-verification')
        .send({ email: 'test@example.com' });

      expect(res.status).toBe(400);
    });
  });
});
