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
  displayName: z
    .string({ error: 'Display name is required' })
    .min(1, 'Display name is required')
    .max(50, 'Display name must be at most 50 characters'),
  password: passwordSchema,
});

export const setPasswordSchema = z.object({
  username: z.string({ error: 'Username is required' }).min(1, 'Username is required'),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string({ error: 'Current password is required' }).min(1, 'Current password is required'),
  newPassword: passwordSchema,
});

export const deleteAccountSchema = z.object({
  password: z.string({ error: 'Password is required' }).min(1, 'Password is required'),
});

/**
 * Format a ZodError into a single error string (first issue message).
 */
export function formatZodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Validation failed';
}
