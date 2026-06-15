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

describe('Username reminder routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /auth/forgot-username', () => {
    it('returns generic success message', async () => {
      vi.spyOn(authService, 'requestUsernameReminder').mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/auth/forgot-username')
        .send({ email: TEST_EMAIL });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('If this email is registered');
    });

    it('returns 400 for invalid email payload', async () => {
      const res = await request(app)
        .post('/auth/forgot-username')
        .send({ email: 'not-an-email' });

      expect(res.status).toBe(400);
    });

    // Timing-oracle de-enumeration: the handler must NOT await the account-dependent
    // work. A never-resolving service mock would hang the request if it were awaited;
    // fire-and-forget returns the generic 200 immediately regardless of email state.
    it('responds without awaiting the work (no enumeration timing oracle)', async () => {
      let release: (v: { success: true }) => void = () => {};
      vi.spyOn(authService, 'requestUsernameReminder').mockReturnValue(
        new Promise<{ success: true }>((resolve) => {
          release = resolve;
        }),
      );

      const res = await request(app)
        .post('/auth/forgot-username')
        .send({ email: TEST_EMAIL });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('If this email is registered');

      release({ success: true }); // settle the dangling promise
    });

    // The safety model rests on detachAuthSideEffect's .catch: if the background work
    // rejects, the endpoint must still answer 200 and must NOT leak an unhandled
    // rejection (vitest fails the run on one) or surface a 500.
    it('swallows a background failure and still returns the generic 200', async () => {
      vi.spyOn(authService, 'requestUsernameReminder').mockRejectedValue(new Error('DB/Resend failure'));

      const res = await request(app)
        .post('/auth/forgot-username')
        .send({ email: TEST_EMAIL });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('If this email is registered');
    });
  });
});
