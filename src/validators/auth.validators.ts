import { z } from 'zod';

// Shared password schema with strength requirements
const passwordSchema = z
  .string({ error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[0-9]/, 'Password must include a number');

// Reserved usernames that cannot be registered.
// Blocks API route prefixes, UI tab names, common reserved words, brand
// impersonation, authority impersonation, and profanity to prevent abuse
// on shareable profile URLs (nalaai.com/<username>).
// Defense-in-depth: auth.service.ts has the same check.
const RESERVED_USERNAMES = new Set([
  // System / admin
  '_system', 'system', 'admin', 'nala', 'support',
  // API route prefixes
  'auth', 'health', 'market', 'portfolio', 'dividends', 'settings', 'insights',
  'goals', 'intelligence', 'leaderboard', 'users', 'social', 'transactions',
  'alerts', 'price-alerts', 'analyst', 'milestones', 'fundamentals', 'watchlists',
  'stock-follows', 'creator', 'referral', 'notifications', 'plaid', 'billing', 'waitlist',
  // UI tab names / routes
  'profile', 'discover', 'feed', 'watch', 'pricing', 'macro',
  // Common reserved words
  'api', 'www', 'app', 'help', 'about', 'login', 'signup', 'register', 'invite',
  'account', 'dashboard', 'home', 'index', 'privacy', 'terms', 'tos',
  'null', 'undefined', 'favicon', 'robots', 'sitemap',
  // Authority / trust impersonation
  'moderator', 'mod', 'staff', 'official', 'verified', 'customer_service',
  'helpdesk', 'operator', 'ceo', 'cto', 'cfo', 'founder', 'developer',
  'engineer', 'security', 'root', 'superuser', 'sysadmin',
  // Brokerage / fintech brand impersonation
  'robinhood', 'fidelity', 'schwab', 'vanguard', 'etrade', 'webull',
  'coinbase', 'binance', 'ameritrade', 'merrill', 'sofi', 'wealthfront',
  'betterment', 'charles_schwab', 'td_ameritrade', 'interactive_brokers',
  // Profanity / slurs
  'fuck', 'shit', 'ass', 'asshole', 'bitch', 'bastard', 'damn', 'dick',
  'pussy', 'cock', 'cunt', 'fag', 'faggot', 'nigger', 'nigga', 'retard',
  'slut', 'whore', 'rape', 'nazi', 'hitler', 'kkk',
]);

const BLOCKED_PREFIXES = ['admin_', 'mod_', 'staff_', 'official_'];
const BLOCKED_SUBSTRINGS_ALWAYS = ['nala'];
const BLOCKED_PROFANITY_PATTERN = /(?:^|_)(fuck|shit|nigger|nigga|faggot|cunt|fag)(?:_|$)/;

function isReservedUsername(val: string): boolean {
  const lower = val.toLowerCase();
  if (RESERVED_USERNAMES.has(lower)) return true;
  if (BLOCKED_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (BLOCKED_SUBSTRINGS_ALWAYS.some((s) => lower.includes(s))) return true;
  if (BLOCKED_PROFANITY_PATTERN.test(lower)) return true;
  return false;
}

// Username format: alphanumeric + underscores, 3-20 chars
const usernameSchema = z
  .string({ error: 'Username is required' })
  .min(3, 'Username must be at least 3 characters')
  .max(20, 'Username must be at most 20 characters')
  .regex(/^[a-zA-Z0-9_]+$/, 'Username must contain only letters, numbers, and underscores')
  .refine((val) => !isReservedUsername(val), 'This username is not allowed');

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

export const forgotUsernameSchema = z.object({
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
