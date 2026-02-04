import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthRequest, JwtPayload } from '../types/auth';

/**
 * Required auth middleware - rejects request if no valid token present
 */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    req.user = payload;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Optional auth middleware - extracts user if token present, continues regardless
 */
export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
      req.user = payload;
    } catch {
      // Invalid token - continue without user context
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
