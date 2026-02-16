import { z } from 'zod';

export const verifyMfaSchema = z.object({
  challengeToken: z.string().min(1, 'Challenge token is required'),
  code: z.string().min(1, 'Verification code is required'),
  method: z.enum(['totp', 'email', 'backup'], { error: 'Invalid MFA method' }),
});

export const totpVerifySetupSchema = z.object({
  code: z.string().length(6, 'Code must be 6 digits').regex(/^\d{6}$/, 'Code must be 6 digits'),
});

export const disableMfaSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

export const updateEmailSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const verifyEmailSchema = z.object({
  code: z.string().length(6, 'Code must be 6 digits').regex(/^\d{6}$/, 'Code must be 6 digits'),
});

export const sendEmailOtpSchema = z.object({
  challengeToken: z.string().min(1, 'Challenge token is required'),
});

export const regenerateBackupCodesSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});
