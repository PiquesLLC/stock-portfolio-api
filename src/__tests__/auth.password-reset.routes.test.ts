import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { TEST_EMAIL } from './helpers';

vi.mock('../middleware/rateLimiter', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const passthrough = (_req: any, _res: any, next: any) => next();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? passthrough : v]),
  );
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

    // Timing-oracle de-enumeration: the handler must NOT await the account-dependent
    // work. A never-resolving service mock would hang the request if it were awaited;
    // fire-and-forget returns the generic 200 immediately regardless of email state.
    it('responds without awaiting the work (no enumeration timing oracle)', async () => {
      let release: (v: { success: true }) => void = () => {};
      vi.spyOn(authService, 'requestPasswordReset').mockReturnValue(
        new Promise<{ success: true }>((resolve) => {
          release = resolve;
        }),
      );

      const res = await request(app)
        .post('/auth/forgot-password')
        .send({ email: TEST_EMAIL });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('If this email is registered');

      release({ success: true }); // settle the dangling promise
    });

    // The safety model rests on detachAuthSideEffect's .catch: if the background work
    // rejects, the endpoint must still answer 200 and must NOT leak an unhandled
    // rejection (vitest fails the run on one) or surface a 500.
    it('swallows a background failure and still returns the generic 200', async () => {
      vi.spyOn(authService, 'requestPasswordReset').mockRejectedValue(new Error('DB/Resend failure'));

      const res = await request(app)
        .post('/auth/forgot-password')
        .send({ email: TEST_EMAIL });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('If this email is registered');
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
