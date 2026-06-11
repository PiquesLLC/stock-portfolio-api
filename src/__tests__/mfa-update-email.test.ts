import { describe, it, expect, vi, beforeEach } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

vi.mock('../services/email.service', () => ({
  sendEmailVerification: vi.fn().mockResolvedValue(undefined),
  sendOtpEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendUsernameReminderEmail: vi.fn().mockResolvedValue(undefined),
  sendEmailChangeVerification: vi.fn().mockResolvedValue(undefined),
  sendEmailChangedNotice: vi.fn().mockResolvedValue(undefined),
}));

import { sendEmailVerification } from '../services/email.service';
import { updateEmail } from '../services/mfa.service';

// ─────────────────────────────────────────────────────────────────────────────
// M1: PUT /auth/mfa/email (updateEmail) must NOT be a primary-email editor.
// It only re-confirms the account's OWN email for MFA-code delivery; setting a
// different address must go through the protected change-email flow. Before the
// fix it overwrote User.email immediately after a password check (silent
// recovery-email swap, no session revocation, no old-address notice).
// ─────────────────────────────────────────────────────────────────────────────

const USER_ID = 'user-m1';
const ACCOUNT_EMAIL = 'owner@example.com';

describe('M1: PUT /auth/mfa/email cannot swap the primary email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({ email: ACCOUNT_EMAIL });
    prismaMock.emailOtpCode.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.emailOtpCode.create.mockResolvedValue({});
  });

  it("re-confirms the account's own email: issues a verification code, mutates nothing", async () => {
    await expect(updateEmail(USER_ID, ACCOUNT_EMAIL)).resolves.toBeUndefined();
    expect(sendEmailVerification).toHaveBeenCalledWith(ACCOUNT_EMAIL, expect.any(String));
    // The primary email is never written by this path.
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    // The code it issues is purpose-scoped to email_verification (H1 invariant).
    expect(prismaMock.emailOtpCode.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ purpose: 'email_verification' }) })
    );
  });

  it('matches the account email case-insensitively', async () => {
    await expect(updateEmail(USER_ID, 'OWNER@Example.com')).resolves.toBeUndefined();
    expect(sendEmailVerification).toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects a DIFFERENT address — no mutation, no code, no email', async () => {
    await expect(updateEmail(USER_ID, 'attacker@evil.com')).rejects.toThrow('EMAIL_CHANGE_NOT_ALLOWED');
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(prismaMock.emailOtpCode.create).not.toHaveBeenCalled();
    expect(sendEmailVerification).not.toHaveBeenCalled();
  });

  it('rejects when the account has no email on file', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ email: null });
    await expect(updateEmail(USER_ID, 'anything@example.com')).rejects.toThrow('EMAIL_CHANGE_NOT_ALLOWED');
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});
