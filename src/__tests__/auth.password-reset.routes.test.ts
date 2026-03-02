import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { TEST_EMAIL } from './helpers';

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
    waitlistJoinLimiter: passthrough,
  };
});

import app from '../app';
import * as authService from '../services/auth.service';

describe('Password reset routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /auth/forgot-password', () => {
    it('returns generic success message', async () => {
      vi.spyOn(authService, 'requestPasswordReset').mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/auth/forgot-password')
        .send({ email: TEST_EMAIL });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('If this email is registered');
    });

    it('returns 400 for invalid email payload', async () => {
      const res = await request(app)
        .post('/auth/forgot-password')
        .send({ email: 'not-an-email' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/reset-password', () => {
    it('returns 200 when reset succeeds', async () => {
      vi.spyOn(authService, 'resetPasswordWithCode').mockResolvedValue({
        success: true,
        remainingAttempts: 5,
      });

      const res = await request(app)
        .post('/auth/reset-password')
        .send({ email: TEST_EMAIL, code: '123456', newPassword: 'StrongPass123' });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Password reset');
    });

    it('returns 400 for invalid/expired code', async () => {
      vi.spyOn(authService, 'resetPasswordWithCode').mockResolvedValue({
        success: false,
        remainingAttempts: 2,
        error: 'INVALID_OR_EXPIRED',
      });

      const res = await request(app)
        .post('/auth/reset-password')
        .send({ email: TEST_EMAIL, code: '111111', newPassword: 'StrongPass123' });

      expect(res.status).toBe(400);
      expect(res.body.remainingAttempts).toBe(2);
    });

    it('returns 429 for too many attempts', async () => {
      vi.spyOn(authService, 'resetPasswordWithCode').mockResolvedValue({
        success: false,
        remainingAttempts: 0,
        error: 'TOO_MANY_ATTEMPTS',
      });

      const res = await request(app)
        .post('/auth/reset-password')
        .send({ email: TEST_EMAIL, code: '111111', newPassword: 'StrongPass123' });

      expect(res.status).toBe(429);
    });
  });
});
