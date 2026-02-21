import axios from 'axios';
import appleSignin from 'apple-signin-auth';
import prisma from '../utils/prisma';
import { config } from '../config';
import { generateAccessToken, generateRefreshToken, CURRENT_POLICY_VERSION } from './auth.service';

// ─── Types ───────────────────────────────────────────────────────────────────

interface OAuthProfile {
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

interface OAuthResult {
  user: OAuthUser;
  isNewUser: boolean;
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
      candidate = `user_${Date.now().toString(36)}`;
    }
  }
  return candidate;
}

// ─── Find or Create OAuth User ───────────────────────────────────────────────

export async function findOrCreateOAuthUser(
  provider: 'google' | 'apple',
  profile: OAuthProfile,
  appleName?: { firstName?: string; lastName?: string },
  consentMeta?: { ipAddress?: string; userAgent?: string },
): Promise<OAuthResult> {
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
      // Link the OAuth provider to the existing account
      await prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          [providerIdField]: profile.providerId,
          emailVerified: true, // Provider verified
          ...(provider === 'google' && profile.picture ? { avatarUrl: profile.picture } : {}),
        },
      });
      return { user: existingByEmail, isNewUser: false };
    }
  }

  // 3. Create new user
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
          });
          return { user: byEmail, isNewUser: false };
        }
      }

      // 3) Any other race/conflict: fail closed
      throw new Error('OAuth account conflict');
    }

    throw err;
  }
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
