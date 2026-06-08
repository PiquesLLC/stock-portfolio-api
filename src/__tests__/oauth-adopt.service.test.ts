import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// findOrCreateOAuthUser: when a real owner signs in via OAuth (email proven) to an email a
// still-UNVERIFIED account is squatting, it must ADOPT that account — link the provider,
// mark verified, and revoke every prior access vector (password, refresh tokens, MFA) —
// rather than failing closed (the denial-of-signup bug). It must NOT adopt when the OAuth
// email is unverified, and must leave the normal verified-link path untouched.

vi.mock('../services/auth.service', () => ({
  generateAccessToken: vi.fn(),
  generateRefreshToken: vi.fn(),
  CURRENT_POLICY_VERSION: 1,
}));
vi.mock('../utils/auth-metrics', () => ({ trackP2002: vi.fn() }));

import { findOrCreateOAuthUser } from '../services/oauth.service';

let byEmailUser: any;

const baseAccount = {
  id: 'squatter1', username: 'sq', displayName: 'Squatter',
  email: 'owner@example.com', emailVerified: false, plan: 'free',
  planExpiresAt: null, createdAt: new Date('2020-01-01'),
};

describe('findOrCreateOAuthUser — OAuth email-squatting adoption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    byEmailUser = null;
    const p = prismaMock as any;
    p.user = {
      // where-aware: by-email returns the configured account; provider-id + generateUsername's
      // username lookup return null. Order-independent, so generateUsername can't desync it.
      findUnique: vi.fn((arg: any) => {
        const w = arg?.where ?? {};
        if (w.email) return Promise.resolve(byEmailUser);
        return Promise.resolve(null);
      }),
      create: vi.fn().mockRejectedValue({ code: 'P2002' }), // collide on the squatted email
      update: vi.fn().mockResolvedValue({ id: 'squatter1' }),
    };
    p.userSettings = { create: vi.fn().mockResolvedValue({}) };
    p.consentRecord = { create: vi.fn().mockResolvedValue({}) };
    p.refreshToken = { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) };
    p.mfaMethod = { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) };
    p.mfaChallenge = { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) };
    p.$transaction = vi.fn((arg: any) =>
      typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg),
    );
  });

  it('adopts an unverified squatted account and revokes all prior access vectors', async () => {
    byEmailUser = { ...baseAccount };
    const result = await findOrCreateOAuthUser('google', {
      providerId: 'g123', email: 'owner@example.com', emailVerified: true, name: 'Real Owner',
    } as any);

    expect(result.isNewUser).toBe(false);
    expect(result.user.id).toBe('squatter1');
    expect(result.user.emailVerified).toBe(true);

    const upd = (prismaMock as any).user.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'squatter1' });
    expect(upd.data.googleId).toBe('g123');
    expect(upd.data.emailVerified).toBe(true);
    expect(upd.data.passwordHash).toBeNull();        // squatter's password wiped
    expect(upd.data.appleId).toBeNull();             // other-provider login cleared (no cross-provider re-entry)
    expect(upd.data.stripeCustomerId).toBeNull();    // squatter's payment linkage not inherited

    expect((prismaMock as any).refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'squatter1' } });
    expect((prismaMock as any).mfaMethod.deleteMany).toHaveBeenCalledWith({ where: { userId: 'squatter1' } });
    expect((prismaMock as any).mfaChallenge.deleteMany).toHaveBeenCalledWith({ where: { userId: 'squatter1' } });
  });

  it('does NOT adopt when the OAuth email is unverified — fails closed, no revocation', async () => {
    byEmailUser = { ...baseAccount };
    await expect(findOrCreateOAuthUser('google', {
      providerId: 'g123', email: 'owner@example.com', emailVerified: false, name: 'Attacker',
    } as any)).rejects.toThrow('OAuth account conflict');

    expect((prismaMock as any).user.update).not.toHaveBeenCalled();
    expect((prismaMock as any).refreshToken.deleteMany).not.toHaveBeenCalled();
  });

  it('links (pending) to an already-verified account without adopting or revoking', async () => {
    byEmailUser = { ...baseAccount, id: 'verified1', emailVerified: true };
    const result = await findOrCreateOAuthUser('google', {
      providerId: 'g999', email: 'owner@example.com', emailVerified: true, name: 'Real Owner',
    } as any);

    expect(result.isNewUser).toBe(false);
    expect((result as any).pendingLink).toBeTruthy();  // link deferred to post-MFA, not revoked
    expect((prismaMock as any).refreshToken.deleteMany).not.toHaveBeenCalled();
    expect((prismaMock as any).user.update).not.toHaveBeenCalled();
  });
});
