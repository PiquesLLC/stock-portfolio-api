import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { AuthRequest, AuthErrorCode } from '../types/auth';
import { verifyTokenDetailed } from '../services/auth.service';
import { isCapacitorRequest } from '../controllers/auth.controller';

function getCookieOptions(req: Request) {
  const capacitor = isCapacitorRequest(req);
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction || capacitor,
    sameSite: isProduction ? ('none' as const) : (capacitor ? ('none' as const) : ('lax' as const)),
    path: '/',
  };
}

/**
 * Extract access token from httpOnly cookie (primary) or Authorization header (fallback)
 */
function extractAccessToken(req: AuthRequest): string | null {
  if (isCapacitorRequest(req)) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
  }

  if (req.cookies?.authToken) {
    return req.cookies.authToken;
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

/**
 * Extract refresh token from httpOnly cookie or request body
 */
function extractRefreshToken(req: AuthRequest): string | null {
  if (req.cookies?.refreshToken) {
    return req.cookies.refreshToken;
  }
  return null;
}

function clearAuthCookies(res: Response, req: Request): void {
  const options = getCookieOptions(req);
  res.clearCookie('authToken', options);
  res.clearCookie('refreshToken', options);
}

/**
 * Internal auth implementation — validates token, returns 401 if invalid/expired.
 * Does NOT attempt token rotation — that is handled exclusively by POST /auth/refresh
 * on the client side (single-threaded via mutex) to prevent race conditions where
 * parallel middleware rotations produce conflicting Set-Cookie headers.
 * Does NOT check email verification.
 */
function _requireAuthImpl(req: AuthRequest, res: Response, next: NextFunction): void {
  const accessToken = extractAccessToken(req);

  if (!accessToken) {
    // No access token — tell client to refresh via POST /auth/refresh.
    // Don't clear cookies: the refresh token cookie may still be valid.
    const hasRefreshToken = !!extractRefreshToken(req);
    res.status(401).json({
      error: hasRefreshToken ? 'Access token expired' : 'Authorization required',
      code: (hasRefreshToken ? 'TOKEN_EXPIRED' : 'NO_TOKEN') as AuthErrorCode,
    });
    return;
  }

  const { payload, expired } = verifyTokenDetailed(accessToken);

  if (payload && !expired) {
    req.user = payload;
    next();
    return;
  }

  if (expired) {
    // Don't clear cookies — refresh token may still be valid for POST /auth/refresh
    res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' as AuthErrorCode });
    return;
  }

  // Token is invalid (not just expired) — cryptographically bad
  clearAuthCookies(res, req);
  res.status(401).json({ error: 'Invalid token', code: 'TOKEN_INVALID' as AuthErrorCode });
}

/**
 * Required auth middleware with email verification gate.
 * Rejects unverified users with 403 EMAIL_NOT_VERIFIED (system user exempted).
 */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const gatedNext = ((err?: any) => {
    // If next was called with an error, pass through
    if (err) {
      next(err);
      return;
    }
    // Gate: block explicitly unverified emails (exempt system user by ID)
    // Use === false so tokens missing the claim (old sessions) pass through until refresh
    // Controlled by EMAIL_VERIFICATION_ENABLED env var (default: off until Resend is active)
    const SYSTEM_USER_ID = '515d3ef4-2b46-4133-8c08-84327b420eba';
    if (config.emailVerificationEnabled && req.user && req.user.userId !== SYSTEM_USER_ID && req.user.emailVerified === false) {
      res.status(403).json({ error: 'Email verification required', code: 'EMAIL_NOT_VERIFIED' as AuthErrorCode });
      return;
    }
    next();
  }) as NextFunction;
  _requireAuthImpl(req, res, gatedNext);
}

/**
 * Auth middleware WITHOUT email verification gate.
 * Use for routes that unverified users need access to (e.g. /me, /set-password, /delete-account).
 */
export function requireAuthAllowUnverified(req: AuthRequest, res: Response, next: NextFunction): void {
  _requireAuthImpl(req, res, next);
}

/**
 * Optional auth middleware - extracts user if token present, continues regardless.
 * Does NOT attempt token rotation — same reasoning as _requireAuthImpl.
 */
export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const accessToken = extractAccessToken(req);

  if (accessToken) {
    const { payload, expired } = verifyTokenDetailed(accessToken);

    if (payload && !expired) {
      req.user = payload;
      next();
      return;
    }

    if (expired) {
      // Token expired — continue without auth. Client will refresh via POST /auth/refresh.
      next();
      return;
    }

    // Token is invalid (not just expired) — clear cookies
    clearAuthCookies(res, req);
  }

  next();
}

/**
 * Ownership verification middleware - ensures authenticated user can only access their own resources.
 * Use after requireAuth middleware.
 */
export function requireOwnership(userIdParam: string = 'userId') {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    // Only check route param — never fall back to client-controlled query/body
    const resourceUserId = req.params[userIdParam];

    if (!req.user) {
      res.status(401).json({ error: 'Authorization required', code: 'NO_TOKEN' as AuthErrorCode });
      return;
    }

    // Fail closed if userId param is missing
    if (!resourceUserId) {
      res.status(400).json({ error: 'Missing userId parameter' });
      return;
    }

    // Verify user owns the resource
    if (resourceUserId !== req.user.userId) {
      res.status(403).json({
        error: `Access denied: you do not own the requested ${userIdParam === 'userId' ? 'resource' : userIdParam.replace('Id', '')}`,
      });
      return;
    }

    next();
  };
}
