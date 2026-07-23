import { z } from 'zod';

export const googleCallbackSchema = z.object({
  access_token: z.string().min(1).max(4096).optional(),
  credential: z.string().min(1).max(4096).optional(),
}).refine(d => d.access_token || d.credential, { message: 'Missing token' });

export const appleCallbackSchema = z.object({
  id_token: z.string().min(1).max(4096),
  nonce: z.string().max(128).optional(),
  user: z.object({
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
  }).strict().optional(),
}).strict();

// Step 2 of a brand-new OAuth signup (age gate). Date semantics are enforced
// in the handler via ageFromDob/MIN_AGE_YEARS — this only bounds the shape.
export const oauthCompleteSchema = z.object({
  signupToken: z.string().min(10).max(4096),
  dateOfBirth: z.string().min(4).max(32),
}).strict();
