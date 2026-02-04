import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthRequest, JwtPayload } from '../types/auth';

/**
 * Extract token from httpOnly cookie (primary) or Authorization header (fallback for API clients)
 */
function extractToken(req: AuthRequest): string | null {
  // Primary: httpOnly cookie
  if (req.cookies?.authToken) {
    return req.cookies.authToken;
  }

  // Fallback: Authorization header (for API clients, mobile apps, etc.)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

/**
 * Required auth middleware - rejects request if no valid token present
 */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    req.user = payload;
    next();
  } catch (err) {
    // Clear invalid cookie if present
    if (req.cookies?.authToken) {
      res.clearCookie('authToken', { httpOnly: true, sameSite: 'strict', path: '/' });
    }
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Optional auth middleware - extracts user if token present, continues regardless
 */
export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (token) {
    try {
      const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
      req.user = payload;
    } catch {
      // Invalid token - continue without user context
      // Clear invalid cookie if present
      if (req.cookies?.authToken) {
        res.clearCookie('authToken', { httpOnly: true, sameSite: 'strict', path: '/' });
      }
    }
  }

  next();
}

/**
 * Ownership verification middleware - ensures authenticated user can only access their own resources
 * Use after requireAuth middleware
 */
export function requireOwnership(userIdParam: string = 'userId') {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const resourceUserId = req.params[userIdParam] || req.query.userId || req.body?.userId;

    if (!req.user) {
      res.status(401).json({ error: 'Authorization required' });
      return;
    }

    // If no userId specified, allow (controller will use req.user.userId)
    if (!resourceUserId) {
      next();
      return;
    }

    // Verify user owns the resource
    if (resourceUserId !== req.user.userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    next();
  };
}
