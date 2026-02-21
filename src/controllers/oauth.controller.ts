import { Request, Response } from 'express';
import { verifyGoogleToken, verifyAppleToken, findOrCreateOAuthUser, issueTokens } from '../services/oauth.service';
import { config } from '../config';
import { getCookieOptions } from './auth.controller';
import { hasMfaEnabled, createMfaChallenge, getEnabledMethods, getMaskedEmail } from '../services/mfa.service';
import { googleCallbackSchema, appleCallbackSchema } from '../validators/oauth.validators';

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

    const { user, isNewUser } = await findOrCreateOAuthUser(
      'google',
      profile,
      undefined,
      { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    );

    // Check if existing user has MFA enabled — before issuing tokens
    if (!isNewUser) {
      const mfaEnabled = await hasMfaEnabled(user.id);
      if (mfaEnabled) {
        const challengeToken = await createMfaChallenge(user.id);
        const methods = await getEnabledMethods(user.id);
        const maskedEmail = await getMaskedEmail(user.id);
        res.json({
          mfaRequired: true,
          challengeToken,
          methods,
          maskedEmail,
        });
        return;
      }
    }

    const loginResponse = await issueTokens(user);
    const { accessOptions, refreshOptions } = getCookieOptions(req);
    res.cookie('authToken', loginResponse.token, accessOptions);
    res.cookie('refreshToken', loginResponse.refreshToken, refreshOptions);
    console.log(`[OAuth] google login: userId=${user.id}, isNew=${isNewUser}, ip=${req.ip}`);
    res.json({ user: loginResponse.user, isNewUser });
  } catch (error: unknown) {
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

    const { user, isNewUser } = await findOrCreateOAuthUser(
      'apple',
      profile,
      appleUser, // { firstName, lastName } — only on first auth
      { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    );

    // Check if existing user has MFA enabled — before issuing tokens
    if (!isNewUser) {
      const mfaEnabled = await hasMfaEnabled(user.id);
      if (mfaEnabled) {
        const challengeToken = await createMfaChallenge(user.id);
        const methods = await getEnabledMethods(user.id);
        const maskedEmail = await getMaskedEmail(user.id);
        res.json({
          mfaRequired: true,
          challengeToken,
          methods,
          maskedEmail,
        });
        return;
      }
    }

    const loginResponse = await issueTokens(user);
    const { accessOptions, refreshOptions } = getCookieOptions(req);
    res.cookie('authToken', loginResponse.token, accessOptions);
    res.cookie('refreshToken', loginResponse.refreshToken, refreshOptions);
    console.log(`[OAuth] apple login: userId=${user.id}, isNew=${isNewUser}, ip=${req.ip}`);
    res.json({ user: loginResponse.user, isNewUser });
  } catch (error: unknown) {
    console.error('Apple OAuth error:', error instanceof Error ? error.message : error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}
