import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import prisma from '../utils/prisma';
import { encrypt, decrypt } from '../utils/encryption';
import { sendOtpEmail, sendEmailVerification } from './email.service';
import { OTP_PURPOSE } from '../types/auth';

const SALT_ROUNDS = 10;
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const EMAIL_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TOTP_ISSUER = 'Nala';
const TOTP_WINDOW = 1; // Allow 1 step before/after for clock drift

// ─── Helpers ────────────────────────────────────────────

function generateOtpCode(): string {
  return String(crypto.randomInt(100000, 999999));
}

function generateBackupCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${local[1]}***@${domain}`;
}

// ─── MFA Status ─────────────────────────────────────────

export async function hasMfaEnabled(userId: string): Promise<boolean> {
  const count = await prisma.mfaMethod.count({
    where: { userId, enabled: true },
  });
  return count > 0;
}

export async function getUserMfaStatus(userId: string) {
  const methods = await prisma.mfaMethod.findMany({
    where: { userId },
    select: { type: true, enabled: true, verifiedAt: true },
  });
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  const backupCodeCount = await prisma.mfaBackupCode.count({
    where: { userId, usedAt: null },
  });
  return {
    methods: methods.map(m => ({ type: m.type, enabled: m.enabled, verifiedAt: m.verifiedAt })),
    email: user?.email || null,
    emailVerified: user?.emailVerified || false,
    backupCodesRemaining: backupCodeCount,
  };
}

export async function getEnabledMethods(userId: string): Promise<string[]> {
  const methods = await prisma.mfaMethod.findMany({
    where: { userId, enabled: true },
    select: { type: true },
  });
  return methods.map(m => m.type);
}

export async function getMaskedEmail(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return user?.email ? maskEmail(user.email) : null;
}

// ─── MFA Challenge ──────────────────────────────────────

// In-memory store for pending OAuth link data attached to MFA challenges.
// Cleaned up when challenge is consumed or expires.
const pendingOAuthLinks = new Map<string, { providerIdField: string; providerId: string; avatarUrl?: string }>();

export async function createMfaChallenge(
  userId: string,
  oauthPendingLink?: { providerIdField: string; providerId: string; avatarUrl?: string },
): Promise<string> {
  const token = crypto.randomBytes(64).toString('hex');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  await prisma.mfaChallenge.create({
    data: { userId, token, expiresAt },
  });

  if (oauthPendingLink) {
    pendingOAuthLinks.set(token, oauthPendingLink);
  }

  return token;
}

/**
 * Atomically consume a challenge token. Returns userId and any pending OAuth
 * link on success, null if invalid/expired/already-used.
 */
export async function consumeMfaChallenge(token: string): Promise<{
  userId: string;
  pendingOAuthLink?: { providerIdField: string; providerId: string; avatarUrl?: string };
} | null> {
  // Look up the challenge first to get the userId
  const challenge = await prisma.mfaChallenge.findUnique({
    where: { token },
  });
  if (!challenge) return null;

  // Atomic: only update if still unused and not expired
  const result = await prisma.mfaChallenge.updateMany({
    where: {
      id: challenge.id,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { usedAt: new Date() },
  });

  // If count is 0, another request won the race or token expired
  if (result.count === 0) return null;

  const pendingLink = pendingOAuthLinks.get(token);
  pendingOAuthLinks.delete(token);

  return { userId: challenge.userId, pendingOAuthLink: pendingLink };
}

/**
 * Peek at a challenge token without consuming it. Used for multi-attempt
 * verification (challenge is consumed only on successful code verification).
 */
export async function peekMfaChallenge(token: string): Promise<string | null> {
  const challenge = await prisma.mfaChallenge.findUnique({
    where: { token },
  });
  if (!challenge) return null;
  if (challenge.usedAt) return null;
  if (challenge.expiresAt < new Date()) return null;
  return challenge.userId;
}

// ─── TOTP ───────────────────────────────────────────────

export async function beginTotpSetup(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true },
  });
  if (!user) throw new Error('User not found');

  // Generate a new TOTP secret
  const secret = new OTPAuth.Secret();
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: user.username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });

  // Encrypt and store (upsert: replace if setup was started but not completed)
  const secretCiphertext = encrypt(secret.base32);
  await prisma.mfaMethod.upsert({
    where: { userId_type: { userId, type: 'totp' } },
    create: { userId, type: 'totp', secretCiphertext, enabled: false },
    update: { secretCiphertext, enabled: false, verifiedAt: null },
  });

  // Generate QR code as data URL
  const qrCodeDataUrl = await QRCode.toDataURL(totp.toString());

  return {
    qrCodeDataUrl,
    secret: secret.base32,
    issuer: TOTP_ISSUER,
    accountName: user.username,
  };
}

export async function verifyTotpSetup(userId: string, code: string): Promise<string[] | null> {
  const method = await prisma.mfaMethod.findUnique({
    where: { userId_type: { userId, type: 'totp' } },
  });
  if (!method || !method.secretCiphertext) return null;

  const secretBase32 = decrypt(method.secretCiphertext);
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });

  const delta = totp.validate({ token: code, window: TOTP_WINDOW });
  if (delta === null) return null;

  await prisma.mfaMethod.update({
    where: { id: method.id },
    data: { enabled: true, verifiedAt: new Date() },
  });

  // Generate backup codes if this is the first MFA method
  const backupCodes = await generateBackupCodes(userId);
  return backupCodes;
}

export async function verifyTotpCode(userId: string, code: string): Promise<boolean> {
  const method = await prisma.mfaMethod.findUnique({
    where: { userId_type: { userId, type: 'totp' } },
  });
  if (!method || !method.enabled || !method.secretCiphertext) return false;

  const secretBase32 = decrypt(method.secretCiphertext);
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });

  const delta = totp.validate({ token: code, window: TOTP_WINDOW });
  return delta !== null;
}

export async function disableTotp(userId: string): Promise<void> {
  await prisma.mfaMethod.deleteMany({
    where: { userId, type: 'totp' },
  });
  // If no MFA methods remain, clean up backup codes
  const remaining = await prisma.mfaMethod.count({ where: { userId, enabled: true } });
  if (remaining === 0) {
    await prisma.mfaBackupCode.deleteMany({ where: { userId } });
  }
}

// ─── Email OTP ──────────────────────────────────────────

export async function updateEmail(userId: string, email: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  // Check uniqueness
  const existing = await prisma.user.findFirst({
    where: { email: normalizedEmail, id: { not: userId } },
  });
  if (existing) throw new Error('Email already in use');

  await prisma.user.update({
    where: { id: userId },
    data: { email: normalizedEmail, emailVerified: false },
    select: { id: true },
  });

  // Send verification code
  const code = generateOtpCode();
  const codeHash = await bcrypt.hash(code, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MS);

  // Invalidate previous codes of the same purpose only — the new-address
  // verification code must not clobber pending reset/MFA codes.
  await prisma.emailOtpCode.updateMany({
    where: { userId, purpose: OTP_PURPOSE.EMAIL_VERIFICATION, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.emailOtpCode.create({
    data: { userId, codeHash, expiresAt, purpose: OTP_PURPOSE.EMAIL_VERIFICATION },
  });

  await sendEmailVerification(normalizedEmail, code);
}

export async function verifyEmail(userId: string, code: string): Promise<boolean> {
  const otpCodes = await prisma.emailOtpCode.findMany({
    where: { userId, purpose: OTP_PURPOSE.EMAIL_VERIFICATION, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  for (const otp of otpCodes) {
    const match = await bcrypt.compare(code, otp.codeHash);
    if (match) {
      const result = await prisma.emailOtpCode.updateMany({
        where: { id: otp.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (result.count === 0) return false;
      await prisma.user.update({
        where: { id: userId },
        data: { emailVerified: true },
        select: { id: true },
      });
      return true;
    }
  }
  return false;
}

export async function beginEmailOtpSetup(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user?.email || !user.emailVerified) {
    throw new Error('Email must be verified before enabling email OTP');
  }

  // Create the method record
  await prisma.mfaMethod.upsert({
    where: { userId_type: { userId, type: 'email' } },
    create: { userId, type: 'email', enabled: false },
    update: { enabled: false, verifiedAt: null },
  });

  // Send a setup verification code
  const code = generateOtpCode();
  const codeHash = await bcrypt.hash(code, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MS);

  await prisma.emailOtpCode.updateMany({
    where: { userId, purpose: OTP_PURPOSE.MFA_SETUP, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.emailOtpCode.create({
    data: { userId, codeHash, expiresAt, purpose: OTP_PURPOSE.MFA_SETUP },
  });

  await sendOtpEmail(user.email, code);
}

export async function verifyEmailOtpSetup(userId: string, code: string): Promise<string[] | null> {
  const otpCodes = await prisma.emailOtpCode.findMany({
    where: { userId, purpose: OTP_PURPOSE.MFA_SETUP, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  for (const otp of otpCodes) {
    const match = await bcrypt.compare(code, otp.codeHash);
    if (match) {
      const result = await prisma.emailOtpCode.updateMany({
        where: { id: otp.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (result.count === 0) return null;

      await prisma.mfaMethod.update({
        where: { userId_type: { userId, type: 'email' } },
        data: { enabled: true, verifiedAt: new Date() },
      });

      const backupCodes = await generateBackupCodes(userId);
      return backupCodes;
    }
  }
  return null;
}

export async function sendEmailOtp(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user?.email) throw new Error('No email on file');

  const code = generateOtpCode();
  const codeHash = await bcrypt.hash(code, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MS);

  // Invalidate previous codes of the same purpose only
  await prisma.emailOtpCode.updateMany({
    where: { userId, purpose: OTP_PURPOSE.MFA_EMAIL, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.emailOtpCode.create({
    data: { userId, codeHash, expiresAt, purpose: OTP_PURPOSE.MFA_EMAIL },
  });

  await sendOtpEmail(user.email, code);
}

export async function verifyEmailOtp(userId: string, code: string): Promise<boolean> {
  const otpCodes = await prisma.emailOtpCode.findMany({
    where: { userId, purpose: OTP_PURPOSE.MFA_EMAIL, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  for (const otp of otpCodes) {
    const match = await bcrypt.compare(code, otp.codeHash);
    if (match) {
      // Atomic: only mark used if still unused (prevents concurrent double-use)
      const result = await prisma.emailOtpCode.updateMany({
        where: { id: otp.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      return result.count > 0;
    }
  }
  return false;
}

export async function disableEmailOtp(userId: string): Promise<void> {
  await prisma.mfaMethod.deleteMany({
    where: { userId, type: 'email' },
  });
  const remaining = await prisma.mfaMethod.count({ where: { userId, enabled: true } });
  if (remaining === 0) {
    await prisma.mfaBackupCode.deleteMany({ where: { userId } });
  }
}

// ─── Backup Codes ───────────────────────────────────────

export async function generateBackupCodes(userId: string): Promise<string[]> {
  // Delete old backup codes
  await prisma.mfaBackupCode.deleteMany({ where: { userId } });

  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const code = generateBackupCode();
    codes.push(code);
    // Hash the normalized form (no hyphen) so verification matches
    const normalized = code.replace(/-/g, '');
    const codeHash = await bcrypt.hash(normalized, SALT_ROUNDS);
    await prisma.mfaBackupCode.create({
      data: { userId, codeHash },
    });
  }

  return codes;
}

export async function verifyBackupCode(userId: string, code: string): Promise<boolean> {
  const backupCodes = await prisma.mfaBackupCode.findMany({
    where: { userId, usedAt: null },
  });

  for (const bc of backupCodes) {
    const match = await bcrypt.compare(code.toLowerCase().replace(/-/g, ''), bc.codeHash);
    if (match) {
      // Atomic: only mark used if still unused (prevents concurrent double-use)
      const result = await prisma.mfaBackupCode.updateMany({
        where: { id: bc.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      return result.count > 0;
    }
  }
  return false;
}
