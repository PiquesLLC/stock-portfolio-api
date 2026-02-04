import rateLimit from 'express-rate-limit';

/**
 * Login rate limiter - strict limits to prevent brute force
 * 5 attempts per 15 minutes per IP/username combination
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Rate limit by both IP and username to prevent distributed attacks
  keyGenerator: (req) => {
    const username = req.body?.username || '';
    return `${req.ip}-${username}`;
  },
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
 * Global API rate limiter - general protection
 * 100 requests per minute
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health';
  },
});
