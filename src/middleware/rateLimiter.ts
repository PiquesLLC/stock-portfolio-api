import { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
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
/**
 * Is this request provably proxied through our Cloudflare zone?
 *
 * H4: the Railway origin (`*.up.railway.app`) is reachable directly, bypassing
 * Cloudflare. Since `CF-Connecting-IP` is just a header, anyone hitting the
 * origin directly can forge it — and because the IP limiters key on it, a forged
 * rotating value resets every per-IP limit (login / MFA / OTP brute force). We
 * therefore trust `CF-Connecting-IP` only when the request also carries a secret
 * `X-Origin-Auth` header injected by a Cloudflare Transform Rule (which a direct
 * origin hit cannot know). Constant-time compared.
 *
 * When `cloudflareOriginSecret` is unset we return `true` to preserve the prior
 * behavior (trust CF-Connecting-IP), so this is inert until the operator wires
 * up the edge rule + secret. See docs/H4-origin-lockdown.md.
 */
export function isViaCloudflare(request: Request): boolean {
  const secret = config.cloudflareOriginSecret;
  if (!secret) return true; // not configured → legacy behavior (inert)
  const provided = request.headers['x-origin-auth'];
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  // timingSafeEqual throws on length mismatch — guard first (length is not secret).
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Real client IP. Behind Cloudflare (nalaai.com) the socket peer is a Cloudflare/
 * Railway proxy, and `trust proxy: 1` cannot reliably recover the origin client
 * across the CF→Railway hops — so every visitor collapses onto ONE shared IP and
 * the IP-keyed limiters bucket the whole site together (a single user then trips
 * the "global" limit by themselves). Cloudflare always sets `CF-Connecting-IP` to
 * the true client, so prefer it — but only when the request is provably via
 * Cloudflare (see isViaCloudflare); otherwise the header is attacker-controlled.
 *
 * For requests NOT provably via Cloudflare we fall back to `request.ip`, i.e. the
 * client IP Railway's edge writes into X-Forwarded-For (with `trust proxy: 1`).
 * This is the trustworthy per-client key for traffic that reaches the origin
 * directly — notably the Capacitor NATIVE app, which always hits the Railway
 * origin (not Cloudflare) and so carries no CF-Connecting-IP. Crucially, using
 * `request.ip` here makes this function identical to the prior behavior whenever
 * `cloudflareOriginSecret` is unset, so deploying the H4 change is inert until
 * the edge rule + secret are configured. We never fall back to a client-settable
 * header, so a forged CF-Connecting-IP on a direct hit is ignored.
 * (Pre-activation, verify Railway's edge writes XFF authoritatively — see
 * docs/H4-origin-lockdown.md.)
 */
export function clientIp(request: Request): string {
  if (isViaCloudflare(request)) {
    const cf = request.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.length > 0) return cf.trim();
  }
  return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
}

function userOrIpKey(request: Request): string {
  const userId = (request as any).user?.userId;
  return userId
    ? `user:${userId}`
    : ipKeyGenerator(clientIp(request));
}

function ipOnlyKey(request: Request): string {
  return ipKeyGenerator(clientIp(request));
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

  // Static front-end assets. The global apiLimiter runs BEFORE express.static
  // (app.ts), so without this every hashed JS/CSS/font/image chunk of an SPA
  // page-load counts against the API budget — dozens of "requests" per refresh.
  // These are cheap, CDN-cached static files, not API calls, and must not
  // consume the limit.
  if (req.path.startsWith('/assets/')) return true;
  if (/\.(?:js|mjs|css|map|woff2?|ttf|eot|png|jpe?g|gif|svg|ico|webp|avif|webmanifest|json|txt)$/i.test(req.path)) return true;

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

/** Heavy reads (charts, portfolio data, news). 300/min prod per user.
 *  An active dashboard fans out many reads per page-load; 120 was easy for a
 *  single engaged user to clip while navigating/refreshing. Still per-user. */
export const heavyReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isProd ? 300 : 1000,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
});

/**
 * Symbol search. 60/min prod per IP (route is unauthenticated). Tighter than
 * heavyReadLimiter (300) because /market/search is a guaranteed paid upstream
 * call (Finnhub /search, per-query cache key is trivially busted) plus a
 * market-cap/ADV enrichment fan-out — i.e. real cost amplification, not a
 * cached dashboard read. Legit use is a 300ms-debounced autocomplete (~3 req/s
 * while typing), so 60/min leaves comfortable headroom. IP-keyed because no
 * auth runs before it. Override via SEARCH_RATE_LIMIT_PER_MIN if NAT collisions
 * appear.
 */
const SEARCH_MAX_PER_MIN = (() => {
  const n = parseInt(process.env.SEARCH_RATE_LIMIT_PER_MIN || '60', 10);
  return Number.isFinite(n) && n > 0 ? n : 60; // guard a typo'd env from disabling the limit
})();
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isProd ? SEARCH_MAX_PER_MIN : 1000,
  message: { error: 'Too many searches. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
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

/** Global safety net. 600/min prod per real client IP (static assets exempt). */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isProd ? 600 : 1000,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey, // real client IP (CF-Connecting-IP), not the collapsed proxy IP
  skip: isTrustedTraffic,
});
