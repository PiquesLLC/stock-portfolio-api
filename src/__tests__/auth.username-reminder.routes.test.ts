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
  });
});
