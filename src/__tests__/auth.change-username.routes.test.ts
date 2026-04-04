import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { generateTestToken, testUser } from './helpers';

vi.mock('../middleware/rateLimiter', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const passthrough = (_req: any, _res: any, next: any) => next();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? passthrough : v]),
  );
});

import app from '../app';
import * as authService from '../services/auth.service';

describe('POST /auth/change-username', () => {
  const origin = 'http://localhost:5173';
  let authCookie: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const token = generateTestToken({ ...testUser, emailVerified: true });
    authCookie = `authToken=${token}`;
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/auth/change-username')
      .send({ username: 'new_handle' });
    expect(res.status).toBe(401);
  });

  it('returns 200 and updated username on success', async () => {
    vi.spyOn(authService, 'changeUsername').mockResolvedValue({
      success: true,
      user: {
        id: testUser.userId,
        username: 'new_handle',
        plan: 'free',
        planExpiresAt: null,
        emailVerified: true,
      },
    });

    const res = await request(app)
      .post('/auth/change-username')
      .set('Origin', origin)
      .set('Cookie', authCookie)
      .send({ username: 'new_handle' });

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('new_handle');
    // Service was called with current user id + new username + old username
    expect(authService.changeUsername).toHaveBeenCalledWith(
      testUser.userId,
      'new_handle',
      testUser.username,
      expect.objectContaining({
        ipAddress: expect.any(String),
      }),
    );
    // Must set a refreshed authToken cookie so JWT picks up new username
    const setCookieHeader = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader].filter(Boolean);
    expect(cookies.some((c: string) => c.startsWith('authToken='))).toBe(true);
  });

  it('returns 409 when username is already taken', async () => {
    vi.spyOn(authService, 'changeUsername').mockResolvedValue({
      success: false,
      error: 'USERNAME_TAKEN',
    });

    const res = await request(app)
      .post('/auth/change-username')
      .set('Origin', origin)
      .set('Cookie', authCookie)
      .send({ username: 'existinguser' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 for reserved username', async () => {
    const res = await request(app)
      .post('/auth/change-username')
      .set('Origin', origin)
      .set('Cookie', authCookie)
      .send({ username: 'admin' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for username containing "nala"', async () => {
    const res = await request(app)
      .post('/auth/change-username')
      .set('Origin', origin)
      .set('Cookie', authCookie)
      .send({ username: 'nalainvestor' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for profanity pattern', async () => {
    const res = await request(app)
      .post('/auth/change-username')
      .set('Origin', origin)
      .set('Cookie', authCookie)
      .send({ username: 'fuck_yeah' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for too short username', async () => {
    const res = await request(app)
      .post('/auth/change-username')
      .set('Origin', origin)
      .set('Cookie', authCookie)
      .send({ username: 'ab' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for too long username', async () => {
    const res = await request(app)
      .post('/auth/change-username')
      .set('Origin', origin)
      .set('Cookie', authCookie)
      .send({ username: 'a'.repeat(21) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid characters', async () => {
    const res = await request(app)
      .post('/auth/change-username')
      .set('Origin', origin)
      .set('Cookie', authCookie)
      .send({ username: 'has spaces' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for admin_ prefix', async () => {
    const res = await request(app)
      .post('/auth/change-username')
      .set('Origin', origin)
      .set('Cookie', authCookie)
      .send({ username: 'admin_bob' });
    expect(res.status).toBe(400);
  });

  it('preserves emailVerified=false in reissued JWT for unverified users (no privilege escalation)', async () => {
    const jwt = await import('jsonwebtoken');
    // Unverified user calls change-username
    const unverifiedToken = generateTestToken({ ...testUser, emailVerified: false });
    const unverifiedCookie = `authToken=${unverifiedToken}`;

    vi.spyOn(authService, 'changeUsername').mockResolvedValue({
      success: true,
      user: {
        id: testUser.userId,
        username: 'new_handle',
        plan: 'free',
        planExpiresAt: null,
        emailVerified: false, // service returns fresh DB value
      },
    });

    const res = await request(app)
      .post('/auth/change-username')
      .set('Origin', origin)
      .set('Cookie', unverifiedCookie)
      .send({ username: 'new_handle' });

    expect(res.status).toBe(200);
    // Extract the new authToken from set-cookie and decode it
    const setCookieHeader = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader].filter(Boolean);
    const authTokenCookie = cookies.find((c: string) => c.startsWith('authToken='));
    expect(authTokenCookie).toBeTruthy();
    const tokenValue = authTokenCookie!.split('=')[1].split(';')[0];
    const decoded: any = jwt.default.decode(tokenValue);
    // CRITICAL: the reissued JWT must not grant emailVerified=true
    expect(decoded.emailVerified).toBe(false);
  });

  it('returns 400 when changing to the exact current username (case-insensitive no-op)', async () => {
    vi.spyOn(authService, 'changeUsername').mockResolvedValue({
      success: false,
      error: 'SAME_USERNAME',
    });

    const res = await request(app)
      .post('/auth/change-username')
      .set('Origin', origin)
      .set('Cookie', authCookie)
      .send({ username: testUser.username });
    expect(res.status).toBe(400);
  });
});
