import { Response, NextFunction } from 'express';
import { config } from '../config';
import { AuthRequest, AuthErrorCode } from '../types/auth';
import { verifyTokenDetailed, rotateRefreshToken } from '../services/auth.service';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
};

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

function clearAuthCookies(res: Response): void {
  res.clearCookie('authToken', COOKIE_OPTIONS);
  res.clearCookie('refreshToken', { ...COOKIE_OPTIONS, path: '/auth/refresh' });
}

/**
 * Required auth middleware - rejects request if no valid token present.
 * If access token is expired but a valid refresh token exists, auto-refreshes.
 */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const accessToken = extractAccessToken(req);

  if (!accessToken) {
    clearAuthCookies(res);
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
          if (result) {
            // Set new cookies
            res.cookie('authToken', result.accessToken, {
              ...COOKIE_OPTIONS,
              maxAge: 15 * 60 * 1000, // 15 minutes
            });
            res.cookie('refreshToken', result.refreshToken, {
              ...COOKIE_OPTIONS,
              path: '/auth/refresh',
              maxAge: config.refreshTokenExpiresInDays * 24 * 60 * 60 * 1000,
            });
            req.user = result.payload;
            next();
          } else {
            clearAuthCookies(res);
            res.status(401).json({ error: 'Session expired. Please log in again.', code: 'TOKEN_EXPIRED' as AuthErrorCode });
          }
        })
        .catch(() => {
          clearAuthCookies(res);
          res.status(401).json({ error: 'Session expired. Please log in again.', code: 'TOKEN_EXPIRED' as AuthErrorCode });
        });
      return;
    }

    clearAuthCookies(res);
    res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' as AuthErrorCode });
    return;
  }

  // Token is invalid (not just expired)
  clearAuthCookies(res);
  res.status(401).json({ error: 'Invalid token', code: 'TOKEN_INVALID' as AuthErrorCode });
}

/**
 * Optional auth middleware - extracts user if token present, continues regardless
 */
export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const accessToken = extractAccessToken(req);

  if (accessToken) {
    const { payload, expired } = verifyTokenDetailed(accessToken);

    if (payload && !expired) {
      req.user = payload;
    } else if (expired) {
      // Clear invalid cookies but don't block the request
      clearAuthCookies(res);
    } else {
      clearAuthCookies(res);
    }
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
