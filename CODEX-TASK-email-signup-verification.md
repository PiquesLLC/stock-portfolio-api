# Codex Task: Require Email at Signup + Email Verification

## Why This Is Critical
Without email verification, bots can create unlimited accounts and abuse our Perplexity API integration (Stock Q&A, Portfolio Briefing, Behavior Coach, Catalyst Detection). Perplexity charges per query — bot abuse could cost us thousands of dollars. Email verification is the gate that prevents this.

## Current State
- **Database**: `User` model already has `email String? @unique` and `emailVerified Boolean @default(false)` fields
- **Email service**: `src/services/email.service.ts` already has `sendEmailVerification(to, code)` using Resend (`noreply@piques.io`)
- **Signup schema**: `src/validators/auth.validators.ts` — currently only requires `username`, `displayName`, `password`, consent booleans. NO email field.
- **Signup handler**: `src/controllers/auth.controller.ts` `signupHandler()` — doesn't collect or store email
- **Signup service**: `src/services/auth.service.ts` `signup()` — doesn't accept or save email

## What to Change

### 1. Add `email` to signup validation (`src/validators/auth.validators.ts`)
```typescript
export const signupSchema = z.object({
  username: usernameSchema,
  email: z.string().email('Please enter a valid email address').max(255),
  displayName: z.string().min(1).max(50),
  password: passwordSchema,
  acceptedPrivacyPolicy: z.literal(true, { error: 'You must accept the Privacy Policy' }),
  acceptedTerms: z.literal(true, { error: 'You must accept the Terms of Service' }),
});
```

### 2. Update `signup()` service (`src/services/auth.service.ts`)
- Accept `email` parameter
- Check email uniqueness: `prisma.user.findUnique({ where: { email } })` — return specific error if taken
- Save email to User record on creation
- After creating the user, generate a 6-digit OTP code, store it in `EmailOtpCode` table, and call `sendEmailVerification(email, code)`
- Set `emailVerified: false` (already the default)

### 3. Update signup handler (`src/controllers/auth.controller.ts`)
- Extract `email` from parsed body
- Pass to `signup()` service
- Return a response that indicates email verification is pending

### 4. Create email verification endpoint
- `POST /auth/verify-email` — accepts `{ email, code }`
- Validates the OTP code against `EmailOtpCode` table (check expiry, max attempts)
- On success: set `emailVerified = true` on the User record
- On failure: return error with remaining attempts

### 5. Create resend verification endpoint
- `POST /auth/resend-verification` — accepts `{ email }`
- Rate limit: max 3 resends per email per hour
- Generates new OTP, invalidates old one, sends new email

### 6. Gate Perplexity features behind email verification
This is the key abuse prevention. In these service files, check `emailVerified` before making Perplexity API calls:
- `src/services/perplexity-qa.service.ts` (Stock Q&A)
- `src/services/perplexity-briefing.service.ts` (Portfolio Briefing)
- `src/services/perplexity-behavior.service.ts` (Behavior Coach)
- `src/services/perplexity-events.service.ts` (Catalyst Detection)

For the system user (`237198da-612e-411c-9ef8-f267c887a9f1`), always allow — this is the shared portfolio user.

### 7. Update auth routes (`src/routes/auth.routes.ts`)
Add the new endpoints:
```
POST /auth/verify-email
POST /auth/resend-verification
```

## Existing Infrastructure to Reuse
- `src/services/email.service.ts` — `sendEmailVerification(to, code)` is already built
- `EmailOtpCode` model in Prisma schema — already exists for MFA email OTP
- `src/services/mfa.service.ts` — has OTP generation/validation logic you can reference

## Flow
1. User fills out signup form (username, email, display name, password, consent)
2. API creates account with `emailVerified: false`, sends verification OTP to email
3. User enters 6-digit code on verification screen
4. API verifies code, sets `emailVerified: true`
5. User can now access Perplexity-powered features
6. Unverified users can still use the app (view portfolio, charts, etc.) but AI features are locked

## Important Notes
- The UI signup form changes will be handled separately (Claude/frontend) — this task is API-only
- The system user should always bypass email verification checks
- Email field should be case-insensitive (lowercase before storing/comparing)
- Don't forget Railway deployment + migration after merging
- Resend API key is already configured in the environment (RESEND_API_KEY)
