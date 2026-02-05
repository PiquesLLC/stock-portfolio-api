import { Router } from 'express';
import { loginHandler, logoutHandler, meHandler, setPasswordHandler, hasPasswordHandler, signupHandler, checkUsernameHandler } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { loginLimiter, setPasswordLimiter, signupLimiter } from '../middleware/rateLimiter';

const router = Router();

// POST /auth/login - Login with username and password (rate limited)
router.post('/login', loginLimiter, loginHandler);

// POST /auth/logout - Clear auth cookie
router.post('/logout', logoutHandler);

// GET /auth/me - Get current authenticated user
router.get('/me', requireAuth, meHandler);

// POST /auth/set-password - Set password for existing user (rate limited)
router.post('/set-password', setPasswordLimiter, setPasswordHandler);

// GET /auth/has-password/:username - Check if user has password set
router.get('/has-password/:username', hasPasswordHandler);

// POST /auth/signup - Create new user account (rate limited)
router.post('/signup', signupLimiter, signupHandler);

// GET /auth/check-username/:username - Check if username is available
router.get('/check-username/:username', checkUsernameHandler);

export default router;
