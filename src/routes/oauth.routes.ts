import { Router } from 'express';
import { googleCallbackHandler, appleCallbackHandler } from '../controllers/oauth.controller';
import { oauthLimiter } from '../middleware/rateLimiter';

const router = Router();

// POST /auth/oauth/google/callback — Exchange Google ID token for session
router.post('/google/callback', oauthLimiter, googleCallbackHandler);

// POST /auth/oauth/apple/callback — Exchange Apple ID token for session
router.post('/apple/callback', oauthLimiter, appleCallbackHandler);

export default router;
