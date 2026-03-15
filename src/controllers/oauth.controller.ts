import { Request, Response } from 'express';
import { verifyGoogleToken, verifyAppleToken, findOrCreateOAuthUser, issueTokens, commitOAuthLink, OAuthProfile } from '../services/oauth.service';
import { config } from '../config';
import { getCookieOptions, isCapacitorRequest } from './auth.controller';
import { hasMfaEnabled, createMfaChallenge, getEnabledMethods, getMaskedEmail } from '../services/mfa.service';
import { googleCallbackSchema, appleCallbackSchema } from '../validators/oauth.validators';
import { trackOAuthSuccess, trackOAuthFail, trackOAuthMfa } from '../utils/auth-metrics';
import prisma from '../utils/prisma';

/**
 * Pre-creation waitlist gate for OAuth signups.
 * Returns true if the user is allowed to proceed, false if blocked.
 * Must be called BEFORE findOrCreateOAuthUser() to avoid create-then-delete races.
 */
async function checkWaitlistForNewOAuthUser(profile: OAuthProfile, res: Response): Promise<boolean> {
  if (!config.waitlistEnabled) return true;

  const email = profile.email?.trim().toLowerCase();

  // No email from provider — can't verify against waitlist, block signup
  if (!email) {
    res.status(403).json({ error: 'WAITLIST_NOT_APPROVED' });
    return false;
  }

  // Check if this provider ID already has an account (existing user login, not new signup)
  const existingByGoogle = await prisma.user.findUnique({ where: { googleId: profile.providerId }, select: { id: true } }).catch(() => null);
  const existingByApple = await prisma.user.findUnique({ where: { appleId: profile.providerId }, select: { id: true } }).catch(() => null);
  if (existingByGoogle || existingByApple) return true; // existing user, skip waitlist

  // Check if email already has an account (will link, not create)
  const existingByEmail = await prisma.user.findUnique({ where: { email }, select: { id: true, emailVerified: true } }).catch(() => null);
  if (existingByEmail && existingByEmail.emailVerified) return true; // existing user, skip waitlist

  // Admin emails bypass the waitlist gate
  if (config.waitlistAdminEmails.includes(email)) return true;

  // New user — check waitlist
  const entry = await prisma.waitlist.findUnique({ where: { email } });
  if (!entry || entry.status !== 'approved') {
    res.status(403).json({ error: 'WAITLIST_NOT_APPROVED' });
    return false;
  }

  return true;
}

/**
 * Mark waitlist entry as converted after successful OAuth signup (non-blocking).
 */
function markWaitlistConverted(email: string | undefined): void {
  if (!config.waitlistEnabled || !email) return;
  const normalized = email.trim().toLowerCase();
  prisma.waitlist.update({ where: { email: normalized }, data: { convertedAt: new Date() } }).catch(() => {});
}

/**
 * POST /auth/oauth/google/callback
 * Body: { access_token: string }  — Google access token from useGoogleLogin()
 */
export async function googleCallbackHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = googleCallbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const accessToken = parsed.data.access_token || parsed.data.credential;
    if (!accessToken) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    if (!config.googleClientId) {
      res.status(503).json({ error: 'Google Sign-In not configured' });
      return;
    }

    const profile = await verifyGoogleToken(accessToken);

    // Waitlist gate: check BEFORE creating any user record
    if (!(await checkWaitlistForNewOAuthUser(profile, res))) return;

    const { user, isNewUser, pendingLink } = await findOrCreateOAuthUser(
      'google',
      profile,
      undefined,
      { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    );

    if (isNewUser) markWaitlistConverted(profile.email);

    // Check if existing user has MFA enabled — before issuing tokens or linking
    if (!isNewUser) {
      const mfaEnabled = await hasMfaEnabled(user.id);
      if (mfaEnabled) {
        // Pass pendingLink to challenge — will be committed after MFA verification
        const challengeToken = await createMfaChallenge(user.id, pendingLink);
        const methods = await getEnabledMethods(user.id);
        const maskedEmail = await getMaskedEmail(user.id);
        trackOAuthMfa('google');
        res.json({
          mfaRequired: true,
          challengeToken,
          methods,
          maskedEmail,
        });
        return;
      }
    }

    // MFA not enabled — safe to commit the provider link
    if (pendingLink) {
      await commitOAuthLink(user.id, pendingLink);
    }

    const loginResponse = await issueTokens(user);
    const { accessOptions, refreshOptions } = getCookieOptions(req);
    res.cookie('authToken', loginResponse.token, accessOptions);
    res.cookie('refreshToken', loginResponse.refreshToken, refreshOptions);
    trackOAuthSuccess('google');
    console.log(`[OAuth] google login: userId=${user.id}, isNew=${isNewUser}, ip=${req.ip}`);
    const isAdmin = config.waitlistAdminUserIds.includes(loginResponse.user.id) ||
      (loginResponse.user.email && loginResponse.user.emailVerified ? config.waitlistAdminEmails.includes(loginResponse.user.email.toLowerCase()) : false);
    const googleBody: any = { user: { ...loginResponse.user, isWaitlistAdmin: isAdmin }, isNewUser };
    if (isCapacitorRequest(req)) {
      googleBody.accessToken = loginResponse.token;
      googleBody.refreshToken = loginResponse.refreshToken;
    }
    res.json(googleBody);
  } catch (error: unknown) {
    trackOAuthFail('google');
    console.error('Google OAuth error:', error instanceof Error ? error.message : error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

/**
 * POST /auth/oauth/apple/callback
 * Body: { id_token: string, user?: { firstName?: string, lastName?: string } }
 * Apple only sends user name on the FIRST authorization
 */
export async function appleCallbackHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = appleCallbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { id_token, nonce, user: appleUser } = parsed.data;

    if (!config.appleClientId) {
      res.status(503).json({ error: 'Apple Sign-In not configured' });
      return;
    }

    const profile = await verifyAppleToken(id_token, nonce);

    // Waitlist gate: check BEFORE creating any user record
    if (!(await checkWaitlistForNewOAuthUser(profile, res))) return;

    const { user, isNewUser, pendingLink } = await findOrCreateOAuthUser(
      'apple',
      profile,
      appleUser, // { firstName, lastName } — only on first auth
      { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    );

    if (isNewUser) markWaitlistConverted(profile.email);

    // Check if existing user has MFA enabled — before issuing tokens or linking
    if (!isNewUser) {
      const mfaEnabled = await hasMfaEnabled(user.id);
      if (mfaEnabled) {
        // Pass pendingLink to challenge — will be committed after MFA verification
        const challengeToken = await createMfaChallenge(user.id, pendingLink);
        const methods = await getEnabledMethods(user.id);
        const maskedEmail = await getMaskedEmail(user.id);
        trackOAuthMfa('apple');
        res.json({
          mfaRequired: true,
          challengeToken,
          methods,
          maskedEmail,
        });
        return;
      }
    }

    // MFA not enabled — safe to commit the provider link
    if (pendingLink) {
      await commitOAuthLink(user.id, pendingLink);
    }

    const loginResponse = await issueTokens(user);
    const { accessOptions, refreshOptions } = getCookieOptions(req);
    res.cookie('authToken', loginResponse.token, accessOptions);
    res.cookie('refreshToken', loginResponse.refreshToken, refreshOptions);
    trackOAuthSuccess('apple');
    console.log(`[OAuth] apple login: userId=${user.id}, isNew=${isNewUser}, ip=${req.ip}`);
    const isAppleAdmin = config.waitlistAdminUserIds.includes(loginResponse.user.id) ||
      (loginResponse.user.email && loginResponse.user.emailVerified ? config.waitlistAdminEmails.includes(loginResponse.user.email.toLowerCase()) : false);
    const appleBody: any = { user: { ...loginResponse.user, isWaitlistAdmin: isAppleAdmin }, isNewUser };
    if (isCapacitorRequest(req)) {
      appleBody.accessToken = loginResponse.token;
      appleBody.refreshToken = loginResponse.refreshToken;
    }
    res.json(appleBody);
  } catch (error: unknown) {
    trackOAuthFail('apple');
    console.error('Apple OAuth error:', error instanceof Error ? error.message : error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}
