import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// Capture outbound codes instead of sending email.
vi.mock('../services/email.service', () => ({
  sendEmailVerification: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendOtpEmail: vi.fn().mockResolvedValue(undefined),
  sendUsernameReminderEmail: vi.fn().mockResolvedValue(undefined),
  sendEmailChangeVerification: vi.fn().mockResolvedValue(undefined),
  sendEmailChangedNotice: vi.fn().mockResolvedValue(undefined),
}));

import { sendEmailVerification, sendPasswordResetEmail, sendOtpEmail } from '../services/email.service';
import {
  resetPasswordWithCode,
  verifyEmailCode,
  requestPasswordReset,
  resendVerificationEmail,
} from '../services/auth.service';
import {
  sendEmailOtp,
  verifyEmailOtp,
  beginEmailOtpSetup,
  verifyEmailOtpSetup,
  updateEmail,
  verifyEmail,
} from '../services/mfa.service';
import { OTP_PURPOSE } from '../types/auth';

// ─────────────────────────────────────────────────────────────────────────────
// H1 regression suite: EmailOtpCode rows are single-purpose. A code minted for
// one flow (verification / MFA / email change) must never satisfy another
// (especially the unauthenticated password reset), and issuing a code for one
// flow must not invalidate pending codes of other flows.
//
// Uses a behavior-faithful in-memory fake of the emailOtpCode model (honoring
// userId/purpose/usedAt/expiresAt filters), so these tests exercise the real
// service logic end to end rather than asserting on query arguments.
// ─────────────────────────────────────────────────────────────────────────────

interface OtpRow {
  id: string;
  userId: string;
  codeHash: string;
  purpose: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

let otpRows: OtpRow[] = [];
let idSeq = 0;

function rowMatches(row: OtpRow, where: any): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  // If a consumer ever drops the purpose filter, `where.purpose` is undefined
  // and the fake matches across purposes — which makes the cross-purpose
  // rejection tests below fail. That is exactly the regression we guard.
  if (where.purpose !== undefined && row.purpose !== where.purpose) return false;
  if ('usedAt' in where && where.usedAt === null && row.usedAt !== null) return false;
  if (where.expiresAt?.gt !== undefined && !(row.expiresAt > where.expiresAt.gt)) return false;
  return true;
}

function installOtpFake(): void {
  prismaMock.emailOtpCode.create.mockImplementation(async ({ data }: any) => {
    idSeq += 1;
    const row: OtpRow = {
      id: `otp-${idSeq}`,
      userId: data.userId,
      codeHash: data.codeHash,
      // Mirrors the schema default: a create that forgets `purpose` mints an
      // unusable 'legacy' row, which the positive-control tests would catch.
      purpose: data.purpose ?? 'legacy',
      expiresAt: data.expiresAt,
      usedAt: null,
      // Strictly increasing so `orderBy createdAt desc` is deterministic even
      // when two codes are minted within the same millisecond.
      createdAt: new Date(Date.now() + idSeq),
    };
    otpRows.push(row);
    return row;
  });
  prismaMock.emailOtpCode.findFirst.mockImplementation(async ({ where }: any) => {
    const hits = otpRows
      .filter((r) => rowMatches(r, where))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return hits[0] ?? null;
  });
  prismaMock.emailOtpCode.findMany.mockImplementation(async ({ where, take }: any) => {
    const hits = otpRows
      .filter((r) => rowMatches(r, where))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return typeof take === 'number' ? hits.slice(0, take) : hits;
  });
  prismaMock.emailOtpCode.updateMany.mockImplementation(async ({ where, data }: any) => {
    let count = 0;
    for (const row of otpRows) {
      if (rowMatches(row, where)) {
        if (data.usedAt !== undefined) row.usedAt = data.usedAt;
        count += 1;
      }
    }
    return { count };
  });
}

const USER = {
  id: 'user-h1',
  username: 'victim',
  email: 'victim@example.com',
  emailVerified: false,
  plan: 'free',
  planExpiresAt: null,
};

function lastCodeSentBy(fn: unknown): string {
  const mock = fn as ReturnType<typeof vi.fn>;
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error('expected an email send to have been captured');
  return call[1] as string;
}

describe('OTP purpose separation (H1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    otpRows = [];
    idSeq = 0;
    installOtpFake();

    prismaMock.user.findUnique.mockImplementation(async ({ where }: any) =>
      where?.email === USER.email || where?.id === USER.id ? { ...USER } : null
    );
    prismaMock.user.findFirst.mockResolvedValue(null); // no email-uniqueness conflicts
    prismaMock.user.update.mockResolvedValue({ id: USER.id });
    prismaMock.notificationAuditLog.count.mockResolvedValue(0);
    prismaMock.notificationAuditLog.create.mockResolvedValue({});
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.mfaMethod.upsert.mockResolvedValue({});
    prismaMock.mfaMethod.update.mockResolvedValue({});
    prismaMock.mfaBackupCode.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.mfaBackupCode.create.mockResolvedValue({});
  });

  // ── Positive controls: each code works in its own flow ────────────────────

  it('accepts a password-reset code for password reset (and still revokes sessions)', async () => {
    await requestPasswordReset(USER.email);
    const code = lastCodeSentBy(sendPasswordResetEmail);

    const result = await resetPasswordWithCode(USER.email, code, 'NewStrongPass1');

    expect(result.success).toBe(true);
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ passwordHash: expect.any(String) }) })
    );
    // Existing post-reset session revocation must be preserved.
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: USER.id }) })
    );
  });

  it('accepts a verification code for email verification', async () => {
    await resendVerificationEmail(USER.email);
    const code = lastCodeSentBy(sendEmailVerification);

    const result = await verifyEmailCode(USER.email, code);
    expect(result.success).toBe(true);
  });

  it('accepts an MFA email code for the MFA challenge, and an MFA setup code for setup', async () => {
    await sendEmailOtp(USER.id);
    const loginCode = lastCodeSentBy(sendOtpEmail);
    expect(await verifyEmailOtp(USER.id, loginCode)).toBe(true);

    prismaMock.user.findUnique.mockResolvedValueOnce({ email: USER.email, emailVerified: true });
    await beginEmailOtpSetup(USER.id);
    const setupCode = lastCodeSentBy(sendOtpEmail);
    expect(await verifyEmailOtpSetup(USER.id, setupCode)).not.toBeNull();
  });

  // ── Cross-purpose rejection: nothing else resets a password ───────────────

  it('rejects an email-verification code for password reset', async () => {
    await resendVerificationEmail(USER.email);
    const code = lastCodeSentBy(sendEmailVerification);

    const result = await resetPasswordWithCode(USER.email, code, 'NewStrongPass1');

    expect(result.success).toBe(false);
    expect(result.error).toBe('INVALID_OR_EXPIRED');
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    // The failed reset attempt must not consume the verification code.
    expect((await verifyEmailCode(USER.email, code)).success).toBe(true);
  });

  it('rejects an MFA login (email OTP) code for password reset', async () => {
    await sendEmailOtp(USER.id);
    const code = lastCodeSentBy(sendOtpEmail);

    const result = await resetPasswordWithCode(USER.email, code, 'NewStrongPass1');

    expect(result.success).toBe(false);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects an MFA setup code for password reset', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({ email: USER.email, emailVerified: true });
    await beginEmailOtpSetup(USER.id);
    const code = lastCodeSentBy(sendOtpEmail);

    const result = await resetPasswordWithCode(USER.email, code, 'NewStrongPass1');

    expect(result.success).toBe(false);
  });

  it('rejects an email-change (new address verification) code for password reset', async () => {
    await updateEmail(USER.id, 'new-address@example.com');
    const code = lastCodeSentBy(sendEmailVerification);

    const result = await resetPasswordWithCode(USER.email, code, 'NewStrongPass1');

    expect(result.success).toBe(false);
    // ...while it still works for its own flow.
    expect(await verifyEmail(USER.id, code)).toBe(true);
  });

  // ── Cross-purpose rejection: a reset code opens nothing else ──────────────

  it('rejects a password-reset code everywhere except password reset', async () => {
    await requestPasswordReset(USER.email);
    const code = lastCodeSentBy(sendPasswordResetEmail);

    expect((await verifyEmailCode(USER.email, code)).success).toBe(false);
    expect(await verifyEmail(USER.id, code)).toBe(false);
    expect(await verifyEmailOtp(USER.id, code)).toBe(false);
    expect(await verifyEmailOtpSetup(USER.id, code)).toBeNull();
  });

  it('rejects an email-verification code for the MFA challenge', async () => {
    await resendVerificationEmail(USER.email);
    const code = lastCodeSentBy(sendEmailVerification);

    expect(await verifyEmailOtp(USER.id, code)).toBe(false);
  });

  // ── Issuance only supersedes codes of the SAME purpose ────────────────────

  it('issuing a verification code does not invalidate a pending reset code', async () => {
    await requestPasswordReset(USER.email);
    const resetCode = lastCodeSentBy(sendPasswordResetEmail);

    await resendVerificationEmail(USER.email);

    const result = await resetPasswordWithCode(USER.email, resetCode, 'NewStrongPass1');
    expect(result.success).toBe(true);
  });

  it('issuing a reset code does not invalidate pending verification or MFA codes', async () => {
    await resendVerificationEmail(USER.email);
    const verifyCode = lastCodeSentBy(sendEmailVerification);
    await sendEmailOtp(USER.id);
    const mfaCode = lastCodeSentBy(sendOtpEmail);

    await requestPasswordReset(USER.email);

    expect(await verifyEmailOtp(USER.id, mfaCode)).toBe(true);
    expect((await verifyEmailCode(USER.email, verifyCode)).success).toBe(true);
  });

  it('still supersedes prior codes of the same purpose on reissue', async () => {
    await requestPasswordReset(USER.email);
    const firstCode = lastCodeSentBy(sendPasswordResetEmail);
    await requestPasswordReset(USER.email);
    const secondCode = lastCodeSentBy(sendPasswordResetEmail);

    expect((await resetPasswordWithCode(USER.email, firstCode, 'NewStrongPass1')).success).toBe(false);
    expect((await resetPasswordWithCode(USER.email, secondCode, 'NewStrongPass1')).success).toBe(true);
  });

  // ── Expiry / single-use behavior unchanged ────────────────────────────────

  it('rejects an expired reset code', async () => {
    await requestPasswordReset(USER.email);
    const code = lastCodeSentBy(sendPasswordResetEmail);
    for (const row of otpRows) row.expiresAt = new Date(Date.now() - 1000);

    const result = await resetPasswordWithCode(USER.email, code, 'NewStrongPass1');
    expect(result.success).toBe(false);
  });

  it('rejects a reset code on second use', async () => {
    await requestPasswordReset(USER.email);
    const code = lastCodeSentBy(sendPasswordResetEmail);

    expect((await resetPasswordWithCode(USER.email, code, 'NewStrongPass1')).success).toBe(true);
    expect((await resetPasswordWithCode(USER.email, code, 'AnotherPass1')).success).toBe(false);
  });

  // ── Migration safety: pre-migration rows are unusable ─────────────────────

  it("never accepts a 'legacy'-purpose row in any consumer", async () => {
    otpRows.push({
      id: 'otp-legacy',
      userId: USER.id,
      codeHash: await bcrypt.hash('123456', 10),
      purpose: 'legacy',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      usedAt: null,
      createdAt: new Date(),
    });

    expect((await resetPasswordWithCode(USER.email, '123456', 'NewStrongPass1')).success).toBe(false);
    expect((await verifyEmailCode(USER.email, '123456')).success).toBe(false);
    expect(await verifyEmailOtp(USER.id, '123456')).toBe(false);
  });

  it('exposes the expected purpose constants', () => {
    expect(OTP_PURPOSE.EMAIL_VERIFICATION).toBe('email_verification');
    expect(OTP_PURPOSE.PASSWORD_RESET).toBe('password_reset');
    expect(OTP_PURPOSE.MFA_SETUP).toBe('mfa_setup');
    expect(OTP_PURPOSE.MFA_EMAIL).toBe('mfa_email');
    expect(OTP_PURPOSE.EMAIL_CHANGE).toBe('email_change');
  });
});
