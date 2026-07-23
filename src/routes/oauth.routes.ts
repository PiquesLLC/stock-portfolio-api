import { Router } from 'express';
import { googleCallbackHandler, appleCallbackHandler, oauthCompleteHandler } from '../controllers/oauth.controller';
import { oauthLimiter } from '../middleware/rateLimiter';

const router = Router();

// POST /auth/oauth/google/callback — Exchange Google ID token for session
router.post('/google/callback', oauthLimiter, googleCallbackHandler);

// POST /auth/oauth/apple/callback — Exchange Apple ID token for session
router.post('/apple/callback', oauthLimiter, appleCallbackHandler);

// POST /auth/oauth/complete — Step 2 of a new OAuth signup: date-of-birth age gate
router.post('/complete', oauthLimiter, oauthCompleteHandler);

export default router;
