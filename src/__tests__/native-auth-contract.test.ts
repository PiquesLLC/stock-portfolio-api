import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// Must be set before config module loads
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.APPLE_CLIENT_ID = 'test-apple-client-id';
process.env.APPLE_SERVICES_ID = 'test-apple-services-id';

vi.mock('../config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const origConfig = actual.config as Record<string, unknown>;
  return {
    ...actual,
    config: {
      ...origConfig,
      googleClientId: 'test-google-client-id',
      appleClientId: 'test-apple-client-id',
      appleServicesId: 'test-apple-services-id',
    },
  };
});

vi.mock('../middleware/rateLimiter', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const passthrough = (_req: any, _res: any, next: any) => next();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? passthrough : v]),
  );
});

const mfaServiceMock = vi.hoisted(() => ({
  getUserMfaStatus: vi.fn(),
  getEnabledMethods: vi.fn(),
  beginTotpSetup: vi.fn(),
  verifyTotpSetup: vi.fn(),
  verifyTotpCode: vi.fn(),
  disableTotp: vi.fn(),
  updateEmail: vi.fn(),
  verifyEmail: vi.fn(),
  beginEmailOtpSetup: vi.fn(),
  verifyEmailOtpSetup: vi.fn(),
  sendEmailOtp: vi.fn(),
  verifyEmailOtp: vi.fn(),
  disableEmailOtp: vi.fn(),
  generateBackupCodes: vi.fn(),
  verifyBackupCode: vi.fn(),
  peekMfaChallenge: vi.fn(),
  consumeMfaChallenge: vi.fn(),
  hasMfaEnabled: vi.fn(),
  createMfaChallenge: vi.fn(),
  getMaskedEmail: vi.fn(),
  // Per-account MFA lockout (F-AUTH2). Default to not-locked for the happy path.
  checkMfaLockout: vi.fn(() => ({ locked: false, retryAfterSec: 0 })),
  recordMfaFailure: vi.fn(),
  clearMfaFailures: vi.fn(),
}));

vi.mock('../services/mfa.service', () => mfaServiceMock);

const oauthServiceMock = vi.hoisted(() => ({
  verifyGoogleToken: vi.fn(),
  verifyAppleToken: vi.fn(),
  findExistingOAuthUser: vi.fn(),
  findOrCreateOAuthUser: vi.fn(),
  issueTokens: vi.fn(),
  commitOAuthLink: vi.fn(),
  signOAuthSignupToken: vi.fn(),
  verifyOAuthSignupToken: vi.fn(),
}));

vi.mock('../services/oauth.service', () => oauthServiceMock);

vi.mock('../utils/auth-metrics', () => ({
  trackOAuthSuccess: vi.fn(),
  trackOAuthFail: vi.fn(),
  trackOAuthMfa: vi.fn(),
}));

import app from '../app';

describe('Native Auth Contract Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      username: 'piques',
      displayName: 'Piques',
      email: 'piques@example.com',
      emailVerified: true,
    });
    (prismaMock as any).waitlist.findUnique.mockResolvedValue({ status: 'approved' });

    mfaServiceMock.peekMfaChallenge.mockResolvedValue('user-1');
    mfaServiceMock.getEnabledMethods.mockResolvedValue(['totp']);
    mfaServiceMock.verifyTotpCode.mockResolvedValue(true);
    mfaServiceMock.verifyEmailOtp.mockResolvedValue(true);
    mfaServiceMock.verifyBackupCode.mockResolvedValue(true);
    mfaServiceMock.consumeMfaChallenge.mockResolvedValue({ pendingOAuthLink: null });
    mfaServiceMock.hasMfaEnabled.mockResolvedValue(false);
    mfaServiceMock.createMfaChallenge.mockResolvedValue('challenge-1');
    mfaServiceMock.getMaskedEmail.mockResolvedValue('p***@example.com');

    oauthServiceMock.verifyGoogleToken.mockResolvedValue({
      providerId: 'google-sub-1',
      email: 'piques@example.com',
      emailVerified: true,
      name: 'Piques',
    });
    oauthServiceMock.verifyAppleToken.mockResolvedValue({
      providerId: 'apple-sub-1',
      email: 'piques@example.com',
      emailVerified: true,
    });
    oauthServiceMock.findExistingOAuthUser.mockResolvedValue({
      user: {
        id: 'user-1',
        username: 'piques',
        displayName: 'Piques',
        email: 'piques@example.com',
        emailVerified: true,
        plan: 'free',
        planExpiresAt: null,
      },
      isNewUser: false,
      pendingLink: null,
    });
    oauthServiceMock.findOrCreateOAuthUser.mockResolvedValue({
      user: {
        id: 'user-1',
        username: 'piques',
        displayName: 'Piques',
        email: 'piques@example.com',
        emailVerified: true,
        plan: 'free',
        planExpiresAt: null,
      },
      isNewUser: false,
      pendingLink: null,
    });
    oauthServiceMock.signOAuthSignupToken.mockReturnValue('signup-token-1');
    oauthServiceMock.verifyOAuthSignupToken.mockReturnValue(null);
    oauthServiceMock.issueTokens.mockResolvedValue({
      user: {
        id: 'user-1',
        username: 'piques',
        displayName: 'Piques',
        email: 'piques@example.com',
        emailVerified: true,
        plan: 'free',
        planExpiresAt: null,
      },
      token: 'access-token-123',
      refreshToken: 'refresh-token-123',
    });
  });

  it('returns token fields from POST /auth/mfa/verify', async () => {
    const res = await request(app)
      .post('/auth/mfa/verify')
      .set('Origin', 'capacitor://localhost')
      .send({ challengeToken: 'challenge-1', code: '123456', method: 'totp' });

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('piques');
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token).toBe(res.body.accessToken);

  });

  it('returns token fields from POST /auth/oauth/google/callback', async () => {
    const res = await request(app)
      .post('/auth/oauth/google/callback')
      .set('Origin', 'capacitor://localhost')
      .send({ access_token: 'google-access-token' });

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('piques');
    expect(res.body.isNewUser).toBe(false);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token).toBe(res.body.accessToken);

  });

  it('returns token fields from POST /auth/oauth/apple/callback', async () => {
    const res = await request(app)
      .post('/auth/oauth/apple/callback')
      .set('Origin', 'capacitor://localhost')
      .send({ id_token: 'apple-id-token' });

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('piques');
    expect(res.body.isNewUser).toBe(false);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token).toBe(res.body.accessToken);

  });
  describe('OAuth age gate (two-step new-user signup)', () => {
    const ADULT_DOB = '1990-01-01';
    // A DOB ~8 years ago stays under MIN_AGE_YEARS regardless of when the suite runs
    const MINOR_DOB = new Date(Date.now() - 8 * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10);

    const newSignupPayload = {
      purpose: 'oauth_signup' as const,
      provider: 'google' as const,
      profile: { providerId: 'google-sub-new', email: 'newbie@example.com', emailVerified: true, name: 'Newbie' },
    };

    it('brand-new Google signup returns requiresDateOfBirth + signupToken and NO session', async () => {
      oauthServiceMock.findExistingOAuthUser.mockResolvedValue(null);

      const res = await request(app)
        .post('/auth/oauth/google/callback')
        .set('Origin', 'capacitor://localhost')
        .send({ access_token: 'google-access-token' });

      expect(res.status).toBe(200);
      expect(res.body.requiresDateOfBirth).toBe(true);
      expect(res.body.signupToken).toBe('signup-token-1');
      expect(res.body.user).toBeUndefined();
      expect(res.body.accessToken).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(oauthServiceMock.findOrCreateOAuthUser).not.toHaveBeenCalled();
    });

    it('POST /auth/oauth/complete with an adult DOB creates the user and returns native token fields', async () => {
      oauthServiceMock.verifyOAuthSignupToken.mockReturnValue(newSignupPayload);
      oauthServiceMock.findOrCreateOAuthUser.mockResolvedValue({
        user: {
          id: 'user-2', username: 'newbie', displayName: 'Newbie',
          email: 'newbie@example.com', emailVerified: true, plan: 'free', planExpiresAt: null,
        },
        isNewUser: true,
      });

      const res = await request(app)
        .post('/auth/oauth/complete')
        .set('Origin', 'capacitor://localhost')
        .send({ signupToken: 'signup-token-1', dateOfBirth: ADULT_DOB });

      expect(res.status).toBe(200);
      expect(res.body.isNewUser).toBe(true);
      expect(typeof res.body.accessToken).toBe('string');
      expect(typeof res.body.refreshToken).toBe('string');
      expect(res.body.token).toBe(res.body.accessToken);
    });

    it('web complete sets cookies and returns NO tokens in the body', async () => {
      oauthServiceMock.verifyOAuthSignupToken.mockReturnValue(newSignupPayload);
      oauthServiceMock.findOrCreateOAuthUser.mockResolvedValue({
        user: {
          id: 'user-2', username: 'newbie', displayName: 'Newbie',
          email: 'newbie@example.com', emailVerified: true, plan: 'free', planExpiresAt: null,
        },
        isNewUser: true,
      });

      const res = await request(app)
        .post('/auth/oauth/complete')
        .send({ signupToken: 'signup-token-1', dateOfBirth: ADULT_DOB });

      expect(res.status).toBe(200);
      expect(res.body.isNewUser).toBe(true);
      expect(res.body.accessToken).toBeUndefined();
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('rejects an under-age DOB with 403 and persists nothing', async () => {
      oauthServiceMock.verifyOAuthSignupToken.mockReturnValue(newSignupPayload);

      const res = await request(app)
        .post('/auth/oauth/complete')
        .send({ signupToken: 'signup-token-1', dateOfBirth: MINOR_DOB });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/at least 13 years old/);
      expect(oauthServiceMock.findOrCreateOAuthUser).not.toHaveBeenCalled();
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('rejects an invalid or expired signup token with 401', async () => {
      oauthServiceMock.verifyOAuthSignupToken.mockReturnValue(null);

      const res = await request(app)
        .post('/auth/oauth/complete')
        .send({ signupToken: 'signup-token-bogus', dateOfBirth: ADULT_DOB });

      expect(res.status).toBe(401);
      expect(oauthServiceMock.findOrCreateOAuthUser).not.toHaveBeenCalled();
    });

    it('refuses to convert a signup token into a session for an existing account (409)', async () => {
      oauthServiceMock.verifyOAuthSignupToken.mockReturnValue(newSignupPayload);
      oauthServiceMock.findOrCreateOAuthUser.mockResolvedValue({
        user: {
          id: 'user-1', username: 'piques', displayName: 'Piques',
          email: 'piques@example.com', emailVerified: true, plan: 'free', planExpiresAt: null,
        },
        isNewUser: false,
      });

      const res = await request(app)
        .post('/auth/oauth/complete')
        .set('Origin', 'capacitor://localhost')
        .send({ signupToken: 'signup-token-1', dateOfBirth: ADULT_DOB });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ACCOUNT_ALREADY_EXISTS');
      expect(res.body.accessToken).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });
});
