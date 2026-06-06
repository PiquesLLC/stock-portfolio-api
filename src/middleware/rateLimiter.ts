import { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { JwtPayload } from '../types/auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Key by authenticated user ID when available, fall back to IP.
 * This prevents shared-IP collateral damage (corporate networks, VPNs)
 * while still rate-limiting unauthenticated abuse by IP.
 */
function userOrIpKey(request: Request): string {
  const userId = (request as any).user?.userId;
  return userId
    ? `user:${userId}`
    : ipKeyGenerator(request.ip ?? 'unknown');
}

function ipOnlyKey(request: Request): string {
  return ipKeyGenerator(request.ip ?? 'unknown');
}

const isProd = process.env.NODE_ENV === 'production';

/**
 * Trusted traffic that bypasses rate limiting.
 * Only the health check endpoint is exempted — webhook providers authenticate
 * via signature verification, so they go through normal rate limits.
 * User-Agent headers are trivially spoofable and must NOT be used for bypass.
 */
function isTrustedTraffic(req: Request): boolean {
  // Health checks (BetterStack uptime monitoring hits /health)
  if (req.path === '/health') return true;

  return false;
}

/**
 * Skip rate limiting for admin user IDs by decoding+verifying the JWT directly
 * from cookies/headers, BEFORE any auth middleware has run. This lets the
 * limiter keep running first (preserves CPU-DoS protection on bad tokens)
 * while still letting admin accounts iterate freely.
 *
 * Bound to specific dedicated limiters below — do NOT attach this to shared
 * limiters reused on unauthenticated routes like /auth/reset-password.
 * Signature verification is required: bare jwt.decode would let an attacker
 * forge a payload claiming admin and bypass the limit.
 */
function isAdminBypassFromToken(req: Request): boolean {
  try {
    const authHeader = req.headers.authorization;
    const bearer = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;
    const cookieToken = (req as { cookies?: { authToken?: string } }).cookies?.authToken;
    const token = bearer || cookieToken;
    if (!token || typeof token !== 'string') return false;
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload;
    return config.waitlistAdminUserIds.includes(payload.userId);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Unauthenticated endpoint limiters (keyed by IP)
// ---------------------------------------------------------------------------

/** Login - prevent brute force. 10/15min prod, 50/15min dev. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 10 : 50,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
  skipSuccessfulRequests: true,
});

/** OAuth callback. 10/15min prod, 50/15min dev. */
export const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 10 : 50,
  message: { error: 'Too many authentication attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
});

/** Password setting. 3/15min. */
export const setPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: 'Too many password attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
});

/** Signup. 5/hour per IP. */
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many signup attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
});

/** Username/password check enumeration. 20/15min prod. */
export const enumerationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 20 : 200,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
});

/** MFA code verify. 5/15min prod. */
export const mfaVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 5 : 50,
  message: { error: 'Too many verification attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
});

/** MFA code send. 3/15min prod. */
export const mfaSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 3 : 50,
  message: { error: 'Too many code requests. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
});

/**
 * Change-email-only variants. Same limits and IP keying as the shared
 * mfaSend/Verify limiters, but with admin bypass via signed-JWT decode.
 * Kept as separate exports so the bypass cannot accidentally leak onto
 * unauthenticated reset-password / forgot-password flows.
 */
export const mfaSendLimiterChangeEmail = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 3 : 50,
  message: { error: 'Too many code requests. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
  skip: isAdminBypassFromToken,
});

export const mfaVerifyLimiterChangeEmail = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 5 : 50,
  message: { error: 'Too many verification attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
  skip: isAdminBypassFromToken,
});

/** Waitlist join. 2/hour prod per IP. */
export const waitlistJoinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isProd ? 2 : 50,
  message: { error: 'Too many signups from this address. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
});

// ---------------------------------------------------------------------------
// Authenticated endpoint limiters (keyed by user ID, fallback to IP)
// ---------------------------------------------------------------------------

/** Generic mutations (POST/PUT/DELETE). 30/min per user. */
export const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
});

/** Billing mutations. 10/min prod per user. */
export const billingMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isProd ? 10 : 50,
  message: { error: 'Too many billing requests. Please try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
});

/** Heavy reads (charts, portfolio data, news). 120/min prod per user. */
export const heavyReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isProd ? 120 : 1000,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
});

// ---------------------------------------------------------------------------
// AI endpoint limiters (keyed by user ID — these cost real money)
// ---------------------------------------------------------------------------

/**
 * AI calls (Perplexity sonar/sonar-pro). 10/min per user.
 * Covers: daily report, briefing, ask, explain, earnings preview, tax harvest.
 */
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isProd ? 10 : 100,
  message: { error: 'AI request limit reached. Please wait a moment before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
});

/**
 * Deep research (Gemini, $2-5 per run). 3/hour per user.
 */
export const deepResearchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isProd ? 3 : 20,
  message: { error: 'Deep research limit reached. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
});

/**
 * Public share-card image generation (unauthenticated, CPU-bound libvips render).
 * IP-keyed to blunt the cost-amplification DoS; CDN caching absorbs repeats.
 * 30/min/IP prod.
 */
export const shareCardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isProd ? 30 : 300,
  message: { error: 'Too many share-card requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// Webhook limiters (keyed by IP, trusted sources whitelisted)
// ---------------------------------------------------------------------------

/** Plaid webhooks. 60/min. */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTrustedTraffic,
});

/** Stripe webhooks. 120/min prod. */
export const billingWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isProd ? 120 : 300,
  message: { error: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTrustedTraffic,
});

// ---------------------------------------------------------------------------
// Global limiter (keyed by IP, trusted traffic whitelisted)
// ---------------------------------------------------------------------------

/** Global safety net. 600/min prod per IP. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isProd ? 600 : 1000,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTrustedTraffic,
});
