import { Request, Response } from 'express';
import { AuthRequest } from '../types/auth';
import { verifyPassword } from '../services/auth.service';
import {
  getUserMfaStatus, getEnabledMethods, beginTotpSetup, verifyTotpSetup, verifyTotpCode,
  disableTotp, updateEmail, verifyEmail, beginEmailOtpSetup,
  verifyEmailOtpSetup, sendEmailOtp, verifyEmailOtp, disableEmailOtp,
  generateBackupCodes, verifyBackupCode, peekMfaChallenge, consumeMfaChallenge,
} from '../services/mfa.service';
import { generateAccessToken, generateRefreshToken } from '../services/auth.service';
import { getCookieOptions, isCapacitorRequest } from './auth.controller';
import { config } from '../config';
import prisma from '../utils/prisma';
import { commitOAuthLink } from '../services/oauth.service';
import {
  verifyMfaSchema, totpVerifySetupSchema, disableMfaSchema,
  updateEmailSchema, verifyEmailSchema, sendEmailOtpSchema,
  regenerateBackupCodesSchema,
} from '../validators/mfa.validators';
import { formatZodError } from '../validators/auth.validators';

// ─── Login MFA Verification ────────────────────────────

export async function verifyMfaHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = verifyMfaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const { challengeToken, code, method } = parsed.data;

    // Peek at the challenge without consuming — allows multiple attempts
    const userId = await peekMfaChallenge(challengeToken);
    if (!userId) {
      res.status(401).json({ error: 'Invalid or expired challenge. Please log in again.' });
      return;
    }

    // Validate the requested method is actually enabled for this user (prevent factor downgrade)
    if (method !== 'backup') {
      const enabledMethods = await getEnabledMethods(userId);
      if (!enabledMethods.includes(method)) {
        res.status(400).json({ error: `${method} is not enabled for this account` });
        return;
      }
    }

    let verified = false;
    if (method === 'totp') {
      verified = await verifyTotpCode(userId, code);
    } else if (method === 'email') {
      verified = await verifyEmailOtp(userId, code);
    } else if (method === 'backup') {
      verified = await verifyBackupCode(userId, code);
    }

    if (!verified) {
      res.status(401).json({ error: 'Invalid verification code' });
      return;
    }

    // Code is valid — NOW consume the challenge atomically
    const consumeResult = await consumeMfaChallenge(challengeToken);
    if (!consumeResult) {
      // Race: another request consumed it between peek and here
      res.status(401).json({ error: 'Challenge already used. Please log in again.' });
      return;
    }

    // MFA passed — commit any pending OAuth provider link
    if (consumeResult.pendingOAuthLink) {
      await commitOAuthLink(userId, consumeResult.pendingOAuthLink);
    }

    // MFA passed — issue real auth tokens
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true, email: true, emailVerified: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const token = generateAccessToken({ userId: user.id, username: user.username });
    const refreshToken = await generateRefreshToken(user.id);

    const isAdmin = config.waitlistAdminUserIds.includes(user.id) ||
      (user.email && user.emailVerified ? config.waitlistAdminEmails.includes(user.email.toLowerCase()) : false);

    const { accessOptions, refreshOptions } = getCookieOptions(req);
    res.cookie('authToken', token, accessOptions);
    res.cookie('refreshToken', refreshToken, refreshOptions);
    const isNative = isCapacitorRequest(req);
    const mfaBody: any = {
      user: { id: user.id, username: user.username, displayName: user.displayName, isWaitlistAdmin: isAdmin },
      ...(isNative ? { accessToken: token, refreshToken, token } : {}),
    };
    res.json(mfaBody);
  } catch (error: unknown) {
    console.error('MFA verify error:');
    res.status(500).json({ error: 'Verification failed' });
  }
}

// ─── Send Email OTP (during login) ────────────────────

export async function sendEmailOtpHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = sendEmailOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    // Peek at challenge without consuming it
    const challenge = await prisma.mfaChallenge.findUnique({
      where: { token: parsed.data.challengeToken },
    });
    if (!challenge || challenge.usedAt || challenge.expiresAt < new Date()) {
      res.status(401).json({ error: 'Invalid or expired challenge' });
      return;
    }

    // Only allow sending email OTP if email method is actually enabled
    const enabledMethods = await getEnabledMethods(challenge.userId);
    if (!enabledMethods.includes('email')) {
      res.status(400).json({ error: 'Email OTP is not enabled for this account' });
      return;
    }

    await sendEmailOtp(challenge.userId);
    res.json({ sent: true });
  } catch (error: unknown) {
    console.error('Send email OTP error:');
    res.status(500).json({ error: 'Failed to send code' });
  }
}

// ─── MFA Status ────────────────────────────────────────

export async function mfaStatusHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const status = await getUserMfaStatus(req.user.userId);
    res.json(status);
  } catch (error: unknown) {
    console.error('MFA status error:');
    res.status(500).json({ error: 'Failed to get MFA status' });
  }
}

// ─── TOTP Setup ────────────────────────────────────────

export async function totpSetupHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }

    // Require password verification before MFA setup (matches disable flow)
    const { password } = req.body ?? {};
    if (!password) {
      res.status(400).json({ error: 'Password is required to set up MFA' });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { passwordHash: true } });
    if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const result = await beginTotpSetup(req.user.userId);
    res.json(result);
  } catch (error: unknown) {
    console.error('TOTP setup error:');
    res.status(500).json({ error: 'Failed to start TOTP setup' });
  }
}

export async function totpVerifySetupHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const parsed = totpVerifySetupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const backupCodes = await verifyTotpSetup(req.user.userId, parsed.data.code);
    if (!backupCodes) {
      res.status(400).json({ error: 'Invalid code. Make sure your authenticator app is synced.' });
      return;
    }
    res.json({ enabled: true, backupCodes });
  } catch (error: unknown) {
    console.error('TOTP verify setup error:');
    res.status(500).json({ error: 'Failed to verify TOTP setup' });
  }
}

export async function totpDisableHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const parsed = disableMfaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { passwordHash: true },
    });
    if (!user?.passwordHash) {
      res.status(400).json({ error: 'No password set' });
      return;
    }
    const valid = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }
    await disableTotp(req.user.userId);
    res.json({ disabled: true });
  } catch (error: unknown) {
    console.error('TOTP disable error:');
    res.status(500).json({ error: 'Failed to disable TOTP' });
  }
}

// ─── Email Management ──────────────────────────────────

export async function updateEmailHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const parsed = updateEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { passwordHash: true } });
    if (!user?.passwordHash) {
      res.status(400).json({ error: 'Password not set' });
      return;
    }
    const valid = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }
    await updateEmail(req.user.userId, parsed.data.email);
    res.json({ email: parsed.data.email, verified: false });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Email already in use') {
      res.status(409).json({ error: 'Email already in use' });
      return;
    }
    console.error('Update email error:');
    res.status(500).json({ error: 'Failed to update email' });
  }
}

export async function verifyEmailHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const verified = await verifyEmail(req.user.userId, parsed.data.code);
    if (!verified) {
      res.status(400).json({ error: 'Invalid or expired code' });
      return;
    }
    res.json({ verified: true });
  } catch (error: unknown) {
    console.error('Verify email error:');
    res.status(500).json({ error: 'Failed to verify email' });
  }
}

// ─── Email OTP Setup ───────────────────────────────────

export async function emailOtpSetupHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }

    // Require password verification before MFA setup
    const { password } = req.body ?? {};
    if (!password) {
      res.status(400).json({ error: 'Password is required to set up MFA' });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { passwordHash: true } });
    if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    await beginEmailOtpSetup(req.user.userId);
    res.json({ codeSent: true });
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Email must be verified')) {
      res.status(400).json({ error: 'Email must be verified before enabling email OTP' });
      return;
    }
    console.error('Email OTP setup error:');
    res.status(500).json({ error: 'Failed to start email OTP setup' });
  }
}

export async function emailOtpVerifySetupHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const backupCodes = await verifyEmailOtpSetup(req.user.userId, parsed.data.code);
    if (!backupCodes) {
      res.status(400).json({ error: 'Invalid or expired code' });
      return;
    }
    res.json({ enabled: true, backupCodes });
  } catch (error: unknown) {
    console.error('Email OTP verify setup error:');
    res.status(500).json({ error: 'Failed to verify email OTP setup' });
  }
}

export async function emailOtpDisableHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const parsed = disableMfaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { passwordHash: true },
    });
    if (!user?.passwordHash) {
      res.status(400).json({ error: 'No password set' });
      return;
    }
    const valid = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }
    await disableEmailOtp(req.user.userId);
    res.json({ disabled: true });
  } catch (error: unknown) {
    console.error('Email OTP disable error:');
    res.status(500).json({ error: 'Failed to disable email OTP' });
  }
}

// ─── Backup Codes ──────────────────────────────────────

export async function regenerateBackupCodesHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const parsed = regenerateBackupCodesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { passwordHash: true },
    });
    if (!user?.passwordHash) {
      res.status(400).json({ error: 'No password set' });
      return;
    }
    const valid = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }
    const codes = await generateBackupCodes(req.user.userId);
    res.json({ backupCodes: codes });
  } catch (error: unknown) {
    console.error('Regenerate backup codes error:');
    res.status(500).json({ error: 'Failed to regenerate backup codes' });
  }
}
