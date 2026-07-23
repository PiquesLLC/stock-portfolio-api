import axios from 'axios';
import appleSignin from 'apple-signin-auth';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma';
import { config } from '../config';
import { generateAccessToken, generateRefreshToken, CURRENT_POLICY_VERSION } from './auth.service';
import { trackP2002 } from '../utils/auth-metrics';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OAuthProfile {
  providerId: string;       // Google sub or Apple sub
  email?: string;
  emailVerified?: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
}

export interface OAuthUser {
  id: string;
  username: string;
  displayName: string;
  email?: string | null;
  emailVerified?: boolean;
  plan: string;
  planExpiresAt: Date | null;
}

export interface OAuthResult {
  user: OAuthUser;
  isNewUser: boolean;
  pendingLink?: { providerIdField: string; providerId: string; avatarUrl?: string };
}

// ─── Google Access Token Verification ────────────────────────────────────────

/**
 * Verifies a Google access token by calling Google's userinfo endpoint.
 * This is the standard OAuth2 flow when using useGoogleLogin() on the frontend.
 */
export async function verifyGoogleToken(accessToken: string): Promise<OAuthProfile> {
  // Step 1: Verify token was issued for our app (audience binding)
  const { data: tokenInfo } = await axios.get(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  );
  if (tokenInfo.aud !== config.googleClientId) {
    throw new Error('Token not issued for this application');
  }

  // Step 2: Fetch user profile
  const { data } = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!data.sub) {
    throw new Error('Invalid Google token — no user ID');
  }

  return {
    providerId: data.sub,
    email: data.email,
    emailVerified: data.email_verified ?? false,
    name: data.name,
    givenName: data.given_name,
    familyName: data.family_name,
    picture: data.picture,
  };
}

// ─── Apple ID Token Verification ─────────────────────────────────────────────

export async function verifyAppleToken(idToken: string, nonce?: string): Promise<OAuthProfile> {
  const payload = await appleSignin.verifyIdToken(idToken, {
    audience: config.appleClientId,
    ignoreExpiration: false,
    ...(nonce ? { nonce } : {}),
  });
  if (!payload.sub) {
    throw new Error('Invalid Apple ID token');
  }
  return {
    providerId: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === 'true' || payload.email_verified === true,
  };
}

// ─── Username Generation ─────────────────────────────────────────────────────

export async function generateUsername(name?: string, email?: string): Promise<string> {
  // Build base from name or email prefix
  let base = '';
  if (name) {
    base = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  }
  if (!base && email) {
    base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
  }
  if (!base) {
    base = 'user';
  }
  // Trim to 20 chars max
  base = base.slice(0, 20);

  // Check uniqueness, append suffix if needed
  let candidate = base;
  const exists = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
  if (exists) {
    candidate = `${base.slice(0, 14)}_${Date.now().toString(36).slice(-5)}`;
    const retry = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
    if (retry) {
      // Use crypto random suffix to guarantee uniqueness
      const { randomBytes } = await import('crypto');
      candidate = `user_${randomBytes(4).toString('hex')}`;
      const last = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
      if (last) {
        candidate = `user_${randomBytes(6).toString('hex')}`;
      }
    }
  }
  return candidate;
}

// ─── Find Existing OAuth User (lookup only — never creates) ─────────────────

/**
 * Resolves an OAuth profile to an EXISTING account: by provider id, or by
 * verified email (as a pending link committed after the MFA check). Returns
 * null when no account matches — i.e. this sign-in would create a brand-new
 * user. The controllers use that null to gate new signups behind the
 * date-of-birth step BEFORE anything is persisted.
 */
export async function findExistingOAuthUser(
  provider: 'google' | 'apple',
  profile: OAuthProfile,
): Promise<OAuthResult | null> {
  const providerIdField = provider === 'google' ? 'googleId' : 'appleId';

  // 1. Look up by provider ID
  const existingByProvider = await prisma.user.findUnique({
    where: { [providerIdField]: profile.providerId } as any,
    select: {
      id: true, username: true, displayName: true,
      email: true, emailVerified: true, plan: true, planExpiresAt: true, createdAt: true,
    },
  });

  if (existingByProvider) {
    // Update avatar if Google provides one
    if (provider === 'google' && profile.picture) {
      await prisma.user.update({
        where: { id: existingByProvider.id },
        data: { avatarUrl: profile.picture },
        select: { id: true },
      }).catch(() => {});
    }
    return { user: existingByProvider, isNewUser: false };
  }

  // 2. Look up by email (if verified) — link provider to existing account
  if (profile.email && profile.emailVerified) {
    const normalizedEmail = profile.email.trim().toLowerCase();
    const existingByEmail = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true, username: true, displayName: true,
        email: true, emailVerified: true, plan: true, planExpiresAt: true, createdAt: true,
      },
    });

    if (existingByEmail && existingByEmail.emailVerified) {
      // Return pending link — only persist AFTER MFA check passes
      return {
        user: existingByEmail,
        isNewUser: false,
        pendingLink: {
          providerIdField,
          providerId: profile.providerId,
          ...(provider === 'google' && profile.picture ? { avatarUrl: profile.picture } : {}),
        },
      };
    }
  }

  return null;
}

// ─── Find or Create OAuth User ───────────────────────────────────────────────

export async function findOrCreateOAuthUser(
  provider: 'google' | 'apple',
  profile: OAuthProfile,
  appleName?: { firstName?: string; lastName?: string },
  consentMeta?: { ipAddress?: string; userAgent?: string },
): Promise<OAuthResult> {
  const providerIdField = provider === 'google' ? 'googleId' : 'appleId';

  const existing = await findExistingOAuthUser(provider, profile);
  if (existing) return existing;

  // Create new user
  const displayName = profile.name
    || (appleName ? [appleName.firstName, appleName.lastName].filter(Boolean).join(' ') : '')
    || profile.givenName
    || 'New User';

  const username = await generateUsername(displayName, profile.email);
  const normalizedEmail = profile.email?.trim().toLowerCase() || null;

  try {
    const newUser = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username,
          displayName,
          email: normalizedEmail,
          emailVerified: profile.emailVerified ?? false,
          passwordHash: null,
          profilePublic: true,
          leaderboardEligible: true,
          trackingStartAt: new Date(),
          [providerIdField]: profile.providerId,
          ...(profile.picture ? { avatarUrl: profile.picture } : {}),
        },
        select: {
          id: true, username: true, displayName: true,
          email: true, emailVerified: true, plan: true, planExpiresAt: true, createdAt: true,
        },
      });

      await tx.userSettings.create({
        data: {
          userId: user.id,
          cashBalance: 0,
          marginDebt: 0,
          dripEnabled: false,
        },
      });

      await tx.consentRecord.create({
        data: {
          userId: user.id,
          policyVersion: CURRENT_POLICY_VERSION,
          ipAddress: consentMeta?.ipAddress,
          userAgent: consentMeta?.userAgent,
        },
      });

      return user;
    });

    // Create default alert preferences (non-blocking — includes congress_trade)
    import('./alert.service').then(m => m.ensureDefaultAlerts(newUser.id)).catch(() => {});

    return { user: newUser, isNewUser: true };
  } catch (err: any) {
    // P2002 = unique constraint violation (concurrent first-login race)
    if (err?.code === 'P2002') {
      // 1) Prefer exact provider match (safe)
      const byProvider = await prisma.user.findUnique({
        where: { [providerIdField]: profile.providerId } as any,
        select: {
          id: true, username: true, displayName: true,
          email: true, emailVerified: true, plan: true, planExpiresAt: true, createdAt: true,
        },
      });
      if (byProvider) {
        trackP2002('byProvider');
        return { user: byProvider, isNewUser: false };
      }

      // 2) Email match is only safe when BOTH sides are verified
      if (normalizedEmail && profile.emailVerified) {
        const byEmail = await prisma.user.findUnique({
          where: { email: normalizedEmail },
          select: {
            id: true, username: true, displayName: true,
            email: true, emailVerified: true, plan: true, planExpiresAt: true, createdAt: true,
          },
        });

        if (byEmail && byEmail.emailVerified) {
          await prisma.user.update({
            where: { id: byEmail.id },
            data: { [providerIdField]: profile.providerId },
            select: { id: true },
          });
          trackP2002('byEmail');
          return { user: byEmail, isNewUser: false };
        }

        // Unverified account squatting this email: the OAuth provider has just proven the
        // caller controls the address, so adopt the account rather than failing closed —
        // link the provider, mark verified, and REVOKE every prior access vector (password,
        // refresh tokens, MFA methods + pending challenges) so a squatter who pre-registered
        // the email retains nothing. Fixes a denial-of-signup that otherwise permanently
        // blocks the real owner's OAuth signup.
        if (byEmail && !byEmail.emailVerified) {
          // Also clear the OTHER provider login: a squatter could have pre-staged this row via
          // an unverified OAuth sign-up under the other provider, and leaving it set would let
          // them re-enter the now-verified account (cross-provider takeover). Drop the password
          // and any inherited Stripe-customer link too. (A squatter's Creator profile /
          // stripeConnectId carryover is a separate, monetization-gated concern — tracked in
          // docs/HANDOFF.md for the creator-payout-enable work.)
          const otherProviderField = providerIdField === 'googleId' ? 'appleId' : 'googleId';
          await prisma.$transaction([
            prisma.user.update({
              where: { id: byEmail.id },
              data: {
                [providerIdField]: profile.providerId,
                [otherProviderField]: null,
                emailVerified: true,
                passwordHash: null,
                stripeCustomerId: null,
              } as any,
              select: { id: true },
            }),
            prisma.refreshToken.deleteMany({ where: { userId: byEmail.id } }),
            prisma.mfaMethod.deleteMany({ where: { userId: byEmail.id } }),
            prisma.mfaChallenge.deleteMany({ where: { userId: byEmail.id } }),
          ]);
          trackP2002('adoptedUnverified');
          return { user: { ...byEmail, emailVerified: true }, isNewUser: false };
        }
      }

      // 3) Any other race/conflict: fail closed
      trackP2002('failed');
      throw new Error('OAuth account conflict');
    }

    throw err;
  }
}

// ─── Commit Pending OAuth Link ──────────────────────────────────────────────

export async function commitOAuthLink(
  userId: string,
  pendingLink: { providerIdField: string; providerId: string; avatarUrl?: string }
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      [pendingLink.providerIdField]: pendingLink.providerId,
      emailVerified: true,
      ...(pendingLink.avatarUrl ? { avatarUrl: pendingLink.avatarUrl } : {}),
    },
    select: { id: true },
  });
}

// ─── Token Issuance (shared helper) ─────────────────────────────────────────

export async function issueTokens(user: OAuthUser): Promise<{
  token: string;
  refreshToken: string;
  user: { id: string; username: string; displayName: string; email?: string | null; emailVerified?: boolean; plan: string; planExpiresAt: Date | null };
}> {
  const token = generateAccessToken({
    userId: user.id,
    username: user.username,
    plan: user.plan,
    planExpiresAt: user.planExpiresAt ? user.planExpiresAt.toISOString() : null,
    emailVerified: user.emailVerified ?? false,
  });
  const refreshToken = await generateRefreshToken(user.id);

  return {
    token,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      emailVerified: user.emailVerified,
      plan: user.plan,
      planExpiresAt: user.planExpiresAt,
    },
  };
}

// ─── OAuth Signup Token (pre-creation age gate) ─────────────────────────────
// A brand-new OAuth sign-in persists NOTHING until the date-of-birth step at
// /auth/oauth/complete passes. The verified provider profile travels in this
// short-lived purpose-scoped JWT instead of a half-provisioned account, so an
// abandoned or failed age check leaves no record, and restarting OAuth simply
// mints a fresh token.

const OAUTH_SIGNUP_TOKEN_TTL_SECONDS = 10 * 60;

export interface OAuthSignupTokenPayload {
  purpose: 'oauth_signup';
  provider: 'google' | 'apple';
  profile: OAuthProfile;
  appleName?: { firstName?: string; lastName?: string };
}

export function signOAuthSignupToken(
  provider: 'google' | 'apple',
  profile: OAuthProfile,
  appleName?: { firstName?: string; lastName?: string },
): string {
  const payload: OAuthSignupTokenPayload = {
    purpose: 'oauth_signup',
    provider,
    profile,
    ...(appleName ? { appleName } : {}),
  };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: OAUTH_SIGNUP_TOKEN_TTL_SECONDS });
}

/**
 * Returns null for any invalid, expired, or wrong-purpose token. An access
 * token can never pass here (no `purpose` claim), and a signup token can never
 * act as an access token (no `userId`, so auth middleware's user lookup fails).
 */
export function verifyOAuthSignupToken(token: string): OAuthSignupTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    if (typeof decoded !== 'object' || decoded === null) return null;
    const payload = decoded as Partial<OAuthSignupTokenPayload>;
    if (payload.purpose !== 'oauth_signup') return null;
    if (payload.provider !== 'google' && payload.provider !== 'apple') return null;
    if (!payload.profile || typeof payload.profile.providerId !== 'string' || !payload.profile.providerId) return null;
    return payload as OAuthSignupTokenPayload;
  } catch {
    return null;
  }
}
