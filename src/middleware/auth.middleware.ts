import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { AuthRequest, AuthErrorCode } from '../types/auth';
import { verifyTokenDetailed, rotateRefreshToken } from '../services/auth.service';

function isCapacitorRequest(req: Request): boolean {
  return req.headers['x-capacitor'] === 'true';
}

function getCookieOptions(req: Request) {
  const capacitor = isCapacitorRequest(req);
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || capacitor,
    sameSite: capacitor ? ('none' as const) : ('lax' as const),
    path: '/',
  };
}

/**
 * Extract access token from httpOnly cookie (primary) or Authorization header (fallback)
 */
function extractAccessToken(req: AuthRequest): string | null {
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
 * Internal auth implementation — validates token, auto-refreshes if needed.
 * Does NOT check email verification.
 */
function _requireAuthImpl(req: AuthRequest, res: Response, next: NextFunction): void {
  const accessToken = extractAccessToken(req);

  if (!accessToken) {
    // Access token cookie expired (browser deleted it) — try refresh token
    const refreshToken = extractRefreshToken(req);
    if (refreshToken) {
      rotateRefreshToken(refreshToken)
        .then((result) => {
          if (result && result.accessToken) {
            const options = getCookieOptions(req);
            res.cookie('authToken', result.accessToken, {
              ...options,
              maxAge: 15 * 60 * 1000, // 15 minutes — matches JWT expiry
            });
            res.cookie('refreshToken', result.refreshToken, {
              ...options,
              maxAge: config.refreshTokenExpiresInDays * 24 * 60 * 60 * 1000,
            });
            req.user = result.payload;
            next();
          } else {
            // Race-loser path returns empty accessToken — update refresh cookie but reject
            if (result && result.refreshToken) {
              const options = getCookieOptions(req);
              res.cookie('refreshToken', result.refreshToken, {
                ...options,
                maxAge: config.refreshTokenExpiresInDays * 24 * 60 * 60 * 1000,
              });
            } else {
              clearAuthCookies(res, req);
            }
            res.status(401).json({ error: 'Session expired. Please log in again.', code: 'TOKEN_EXPIRED' as AuthErrorCode });
          }
        })
        .catch(() => {
          clearAuthCookies(res, req);
          res.status(401).json({ error: 'Session expired. Please log in again.', code: 'TOKEN_EXPIRED' as AuthErrorCode });
        });
      return;
    }
    clearAuthCookies(res, req);
    res.status(401).json({ error: 'Authorization required', code: 'NO_TOKEN' as AuthErrorCode });
    return;
  }

  const { payload, expired } = verifyTokenDetailed(accessToken);

  if (payload && !expired) {
    req.user = payload;
    next();
    return;
  }

  if (expired) {
    // Try auto-refresh using refresh token cookie
    const refreshToken = extractRefreshToken(req);
    if (refreshToken) {
      rotateRefreshToken(refreshToken)
        .then((result) => {
          if (result && result.accessToken) {
            const options = getCookieOptions(req);
            res.cookie('authToken', result.accessToken, {
              ...options,
              maxAge: 15 * 60 * 1000, // 15 minutes — matches JWT expiry
            });
            res.cookie('refreshToken', result.refreshToken, {
              ...options,
              maxAge: config.refreshTokenExpiresInDays * 24 * 60 * 60 * 1000,
            });
            req.user = result.payload;
            next();
          } else {
            if (result && result.refreshToken) {
              const options = getCookieOptions(req);
              res.cookie('refreshToken', result.refreshToken, {
                ...options,
                maxAge: config.refreshTokenExpiresInDays * 24 * 60 * 60 * 1000,
              });
            } else {
              clearAuthCookies(res, req);
            }
            res.status(401).json({ error: 'Session expired. Please log in again.', code: 'TOKEN_EXPIRED' as AuthErrorCode });
          }
        })
        .catch(() => {
          clearAuthCookies(res, req);
          res.status(401).json({ error: 'Session expired. Please log in again.', code: 'TOKEN_EXPIRED' as AuthErrorCode });
        });
      return;
    }

    clearAuthCookies(res, req);
    res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' as AuthErrorCode });
    return;
  }

  // Token is invalid (not just expired)
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
    // Gate: block explicitly unverified emails (exempt _system user)
    // Use === false so tokens missing the claim (old sessions) pass through until refresh
    if (req.user && req.user.username !== '_system' && req.user.emailVerified === false) {
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
 * If access token is expired but refresh token exists, silently refreshes.
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
      // Try silent refresh instead of just clearing cookies
      const refreshToken = extractRefreshToken(req);
      if (refreshToken) {
        rotateRefreshToken(refreshToken)
          .then((result) => {
            if (result && result.accessToken) {
              const options = getCookieOptions(req);
              res.cookie('authToken', result.accessToken, {
                ...options,
                maxAge: 15 * 60 * 1000,
              });
              res.cookie('refreshToken', result.refreshToken, {
                ...options,
                maxAge: config.refreshTokenExpiresInDays * 24 * 60 * 60 * 1000,
              });
              req.user = result.payload;
            } else if (result && result.refreshToken) {
              // Race-loser: update refresh cookie but don't authenticate
              const options = getCookieOptions(req);
              res.cookie('refreshToken', result.refreshToken, {
                ...options,
                maxAge: config.refreshTokenExpiresInDays * 24 * 60 * 60 * 1000,
              });
            }
            next();
          })
          .catch(() => { next(); });
        return;
      }
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
    const resourceUserId = req.params[userIdParam] || req.query.userId || req.body?.userId;

    if (!req.user) {
      res.status(401).json({ error: 'Authorization required', code: 'NO_TOKEN' as AuthErrorCode });
      return;
    }

    // If no userId specified, allow (controller will use req.user.userId)
    if (!resourceUserId) {
      next();
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
