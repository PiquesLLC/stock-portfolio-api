import { z } from 'zod';

// Shared password schema with strength requirements
const passwordSchema = z
  .string({ error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[0-9]/, 'Password must include a number');

// Username format: alphanumeric + underscores, 3-20 chars
const usernameSchema = z
  .string({ error: 'Username is required' })
  .min(3, 'Username must be at least 3 characters')
  .max(20, 'Username must be at most 20 characters')
  .regex(/^[a-zA-Z0-9_]+$/, 'Username must contain only letters, numbers, and underscores');

export const loginSchema = z.object({
  username: z.string({ error: 'Username is required' }).min(1, 'Username is required'),
  password: z.string({ error: 'Password is required' }).min(1, 'Password is required'),
});

export const signupSchema = z.object({
  username: usernameSchema,
  email: z.string({ error: 'Email is required' }).email('Please enter a valid email address').max(255),
  displayName: z
    .string({ error: 'Display name is required' })
    .min(1, 'Display name is required')
    .max(50, 'Display name must be at most 50 characters'),
  password: passwordSchema,
  acceptedPrivacyPolicy: z.literal(true, {
    error: 'You must accept the Privacy Policy',
  }),
  acceptedTerms: z.literal(true, {
    error: 'You must accept the Terms of Service',
  }),
  referralCode: z.string().max(20).optional(),
});

export const setPasswordSchema = z.object({
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string({ error: 'Current password is required' }).min(1, 'Current password is required'),
  newPassword: passwordSchema,
});

export const deleteAccountSchema = z.object({
  password: z.string({ error: 'Password is required' }).min(1, 'Password is required'),
});

export const verifyEmailSchema = z.object({
  email: z.string({ error: 'Email is required' }).email('Please enter a valid email address').max(255),
  code: z.string({ error: 'Code is required' }).regex(/^\d{6}$/, 'Code must be 6 digits'),
});

export const resendVerificationSchema = z.object({
  email: z.string({ error: 'Email is required' }).email('Please enter a valid email address').max(255),
});

export const forgotPasswordSchema = z.object({
  email: z.string({ error: 'Email is required' }).email('Please enter a valid email address').max(255),
});

export const resetPasswordSchema = z.object({
  email: z.string({ error: 'Email is required' }).email('Please enter a valid email address').max(255),
  code: z.string({ error: 'Code is required' }).regex(/^\d{6}$/, 'Code must be 6 digits'),
  newPassword: passwordSchema,
});

/**
 * Format a ZodError into a single error string (first issue message).
 */
export function formatZodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Validation failed';
}
