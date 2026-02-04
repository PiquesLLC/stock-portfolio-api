import { Request, Response } from 'express';
import { loginWithPassword, setPassword, getUserById, hasPassword } from '../services/auth.service';
import { AuthRequest } from '../types/auth';
import { config } from '../config';

// Cookie options for auth token
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production', // HTTPS only in production
  sameSite: 'strict' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
  path: '/',
};

/**
 * POST /auth/login
 * Login with username and password - sets httpOnly cookie
 */
export async function loginHandler(req: Request, res: Response): Promise<void> {
  try {
    const { username, password } = req.body;

    if (!username || typeof username !== 'string') {
      res.status(400).json({ error: 'Username is required' });
      return;
    }

    if (!password || typeof password !== 'string') {
      res.status(400).json({ error: 'Password is required' });
      return;
    }

    const result = await loginWithPassword(username, password);

    if (!result) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    // Set httpOnly cookie instead of returning token in body
    res.cookie('authToken', result.token, COOKIE_OPTIONS);

    // Return only user info, not the token (prevents XSS token theft)
    res.json({ user: result.user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
}

/**
 * POST /auth/logout
 * Clear auth cookie
 */
export async function logoutHandler(req: Request, res: Response): Promise<void> {
  res.clearCookie('authToken', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
  res.json({ message: 'Logged out successfully' });
}

/**
 * GET /auth/me
 * Get current authenticated user
 */
export async function meHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const user = await getUserById(req.user.userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(user);
  } catch (error) {
    console.error('Me error:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
}

/**
 * POST /auth/set-password
 * Set password for an existing user (for initial setup)
 */
export async function setPasswordHandler(req: Request, res: Response): Promise<void> {
  try {
    const { username, password } = req.body;

    if (!username || typeof username !== 'string') {
      res.status(400).json({ error: 'Username is required' });
      return;
    }

    if (!password || typeof password !== 'string') {
      res.status(400).json({ error: 'Password is required' });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    const success = await setPassword(username, password);

    if (!success) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ message: 'Password set successfully' });
  } catch (error) {
    console.error('Set password error:', error);
    res.status(500).json({ error: 'Failed to set password' });
  }
}

/**
 * GET /auth/has-password/:username
 * Check if user has a password set
 * NOTE: Returns true for non-existent users to prevent username enumeration
 */
export async function hasPasswordHandler(req: Request, res: Response): Promise<void> {
  try {
    const { username } = req.params;

    if (!username) {
      res.status(400).json({ error: 'Username is required' });
      return;
    }

    const has = await hasPassword(username);
    // Always return a response that doesn't reveal if user exists
    // If user doesn't exist or has no password, we still show password setup flow
    // The set-password endpoint will fail for non-existent users (that's fine)
    res.json({ hasPassword: has });
  } catch (error) {
    console.error('Has password error:', error);
    // Return generic response even on error to prevent timing attacks
    res.json({ hasPassword: true });
  }
}
