import rateLimit from 'express-rate-limit';

/**
 * Login rate limiter - prevent brute force
 * 10 attempts per 15 minutes in production, 50 in dev
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 10 : 50,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful logins
});

/**
 * OAuth callback rate limiter - stricter than generic mutations
 * 10 attempts per 15 minutes in production, 50 in dev
 */
export const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 50,
  message: { error: 'Too many authentication attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Password setting rate limiter
 * 3 attempts per 15 minutes
 */
export const setPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3,
  message: { error: 'Too many password attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Signup rate limiter
 * 5 signups per hour per IP
 */
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many signup attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Mutation rate limiter - protect POST/PUT/DELETE endpoints
 * 30 mutations per minute per IP
 */
export const mutationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 mutations per minute
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Billing mutation limiter - stricter than generic mutation endpoints.
 */
export const billingMutationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'production' ? 10 : 50,
  message: { error: 'Too many billing requests. Please try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Heavy read limiter - protect expensive GET endpoints (charts, AI, news, etc.)
 */
export const heavyReadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'production' ? 120 : 1000,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Enumeration rate limiter - for check-username, has-password etc.
 * Does NOT skip successful requests (unlike loginLimiter).
 */
export const enumerationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 20 : 200,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * MFA verification rate limiter - prevent brute force
 * 5 attempts per 15 minutes in production
 */
export const mfaVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 5 : 50,
  message: { error: 'Too many verification attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * MFA send rate limiter - prevent email spam
 * 3 sends per 15 minutes in production
 */
export const mfaSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 3 : 50,
  message: { error: 'Too many code requests. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Webhook rate limiter - protect inbound webhook endpoint from abuse
 * Generous threshold (60/min) since Plaid controls delivery cadence
 * and the handler already verifies JWT + body SHA-256 before any mutation
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  message: { error: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Billing webhook limiter - separate profile for Stripe webhook traffic.
 */
export const billingWebhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'production' ? 120 : 300,
  message: { error: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Waitlist join rate limiter - prevent spam signups
 * 5 attempts per hour per IP in production
 */
export const waitlistJoinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: process.env.NODE_ENV === 'production' ? 5 : 50,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Global API rate limiter - general protection
 * Higher limits in dev to support pre-fetching and background tasks
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'production' ? 600 : 1000, // Higher for real-time dashboard
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health checks only
    if (req.path === '/health') return true;
    return false;
  },
});
