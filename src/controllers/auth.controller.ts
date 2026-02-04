import { Request, Response } from 'express';
import { loginWithPassword, setPassword, getUserById, hasPassword } from '../services/auth.service';
import { AuthRequest } from '../types/auth';

/**
 * POST /auth/login
 * Login with username and password
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

    res.json(result);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
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
 */
export async function hasPasswordHandler(req: Request, res: Response): Promise<void> {
  try {
    const { username } = req.params;

    if (!username) {
      res.status(400).json({ error: 'Username is required' });
      return;
    }

    const has = await hasPassword(username);
    res.json({ hasPassword: has });
  } catch (error) {
    console.error('Has password error:', error);
    res.status(500).json({ error: 'Failed to check password status' });
  }
}
