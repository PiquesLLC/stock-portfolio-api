import { Request, Response } from 'express';
import { verifyGoogleToken, verifyAppleToken, findOrCreateOAuthUser, findExistingOAuthUser, issueTokens, commitOAuthLink, signOAuthSignupToken, verifyOAuthSignupToken, OAuthProfile, OAuthUser } from '../services/oauth.service';
import { config } from '../config';
import { getCookieOptions, isCapacitorRequest } from './auth.controller';
import { hasMfaEnabled, createMfaChallenge, getEnabledMethods, getMaskedEmail } from '../services/mfa.service';
import { googleCallbackSchema, appleCallbackSchema, oauthCompleteSchema } from '../validators/oauth.validators';
import { ageFromDob, MIN_AGE_YEARS } from '../validators/auth.validators';
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
 * Issue the session (cookies for web, tokens in body for native) and send the
 * standard OAuth login response. Shared by both provider callbacks and the
 * signup-completion handler so the response contract can't drift.
 */
async function sendOAuthSession(
  req: Request,
  res: Response,
  user: OAuthUser,
  provider: 'google' | 'apple',
  isNewUser: boolean,
): Promise<void> {
  const loginResponse = await issueTokens(user);
  const { accessOptions, refreshOptions } = getCookieOptions(req);
  res.cookie('authToken', loginResponse.token, accessOptions);
  res.cookie('refreshToken', loginResponse.refreshToken, refreshOptions);
  trackOAuthSuccess(provider);
  // M-13: the client IP is personal data and was being written to stdout on every
  // OAuth login, where it persists in Railway logs well beyond the request. The
  // userId is the identifier we actually need for triage; drop the IP.
  console.log(`[OAuth] ${provider} login: userId=${user.id}, isNew=${isNewUser}`);
  const isAdmin = config.waitlistAdminUserIds.includes(loginResponse.user.id) ||
    (loginResponse.user.email && loginResponse.user.emailVerified ? config.waitlistAdminEmails.includes(loginResponse.user.email.toLowerCase()) : false);
  const isNative = isCapacitorRequest(req);
  res.json({
    user: { ...loginResponse.user, isWaitlistAdmin: isAdmin },
    isNewUser,
    ...(isNative ? { accessToken: loginResponse.token, refreshToken: loginResponse.refreshToken, token: loginResponse.token } : {}),
  });
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

    const existing = await findExistingOAuthUser('google', profile);

    if (!existing) {
      // Brand-new signup: persist nothing until the date-of-birth step at
      // /auth/oauth/complete passes (age gate).
      const signupToken = signOAuthSignupToken('google', profile);
      console.log('[OAuth] google signup pending DOB');
      res.json({ requiresDateOfBirth: true, signupToken });
      return;
    }

    const { user, pendingLink } = existing;

    // Check if existing user has MFA enabled — before issuing tokens or linking
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

    // MFA not enabled — safe to commit the provider link
    if (pendingLink) {
      await commitOAuthLink(user.id, pendingLink);
    }

    await sendOAuthSession(req, res, user, 'google', false);
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

    const existing = await findExistingOAuthUser('apple', profile);

    if (!existing) {
      // Brand-new signup: persist nothing until the date-of-birth step at
      // /auth/oauth/complete passes (age gate). Apple only sends the user's
      // name on this first authorization — carry it in the signup token.
      const signupToken = signOAuthSignupToken('apple', profile, appleUser);
      console.log('[OAuth] apple signup pending DOB');
      res.json({ requiresDateOfBirth: true, signupToken });
      return;
    }

    const { user, pendingLink } = existing;

    // Check if existing user has MFA enabled — before issuing tokens or linking
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

    // MFA not enabled — safe to commit the provider link
    if (pendingLink) {
      await commitOAuthLink(user.id, pendingLink);
    }

    await sendOAuthSession(req, res, user, 'apple', false);
  } catch (error: unknown) {
    trackOAuthFail('apple');
    console.error('Apple OAuth error:', error instanceof Error ? error.message : error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

/**
 * POST /auth/oauth/complete
 * Body: { signupToken: string, dateOfBirth: 'YYYY-MM-DD' }
 * Step 2 of a brand-new OAuth signup — the age gate. The signed signupToken
 * carries the verified provider profile from step 1; the account is only
 * created here, after the date of birth passes the MIN_AGE_YEARS check.
 */
export async function oauthCompleteHandler(req: Request, res: Response): Promise<void> {
  const parsed = oauthCompleteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const payload = verifyOAuthSignupToken(parsed.data.signupToken);
  if (!payload) {
    res.status(401).json({ error: 'Your signup session expired — please sign in again' });
    return;
  }
  const { provider, profile, appleName } = payload;

  try {
    const age = ageFromDob(parsed.data.dateOfBirth);
    if (age === null) {
      res.status(400).json({ error: 'Please enter a valid date of birth' });
      return;
    }
    if (age < MIN_AGE_YEARS) {
      // Reject BEFORE any account exists — nothing about the visitor is persisted.
      res.status(403).json({ error: `You must be at least ${MIN_AGE_YEARS} years old to use Nala` });
      return;
    }

    // Re-run the waitlist gate — approval may have changed since step 1
    if (!(await checkWaitlistForNewOAuthUser(profile, res))) return;

    const { user, isNewUser } = await findOrCreateOAuthUser(
      provider,
      profile,
      appleName,
      { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    );

    if (!isNewUser) {
      // The account materialized between step 1 and step 2 (parallel signup or
      // token replay after completion). Never convert a signup token into a
      // session for an existing account — a fresh provider sign-in goes through
      // the normal path, including its MFA challenge.
      res.status(409).json({ error: 'ACCOUNT_ALREADY_EXISTS' });
      return;
    }

    markWaitlistConverted(profile.email);
    await sendOAuthSession(req, res, user, provider, true);
  } catch (error: unknown) {
    trackOAuthFail(provider);
    console.error('OAuth complete error:', error instanceof Error ? error.message : error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}
