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
    // Skip rate limiting for health checks and GET requests in development
    if (req.path === '/health') return true;
    if (process.env.NODE_ENV !== 'production' && req.method === 'GET') return true;
    return false;
  },
});
