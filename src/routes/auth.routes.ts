import { Router } from 'express';
import { loginHandler, meHandler, setPasswordHandler, hasPasswordHandler } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// POST /auth/login - Login with username and password
router.post('/login', loginHandler);

// GET /auth/me - Get current authenticated user
router.get('/me', requireAuth, meHandler);

// POST /auth/set-password - Set password for existing user
router.post('/set-password', setPasswordHandler);

// GET /auth/has-password/:username - Check if user has password set
router.get('/has-password/:username', hasPasswordHandler);

export default router;
