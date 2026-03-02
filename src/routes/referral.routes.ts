import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { enumerationLimiter } from '../middleware/rateLimiter';
import { getReferralStatsHandler, validateReferralCodeHandler } from '../controllers/referral.controller';

const router = Router();

// Public — validate a referral code (rate limited to prevent username enumeration)
router.get('/validate/:code', enumerationLimiter, validateReferralCodeHandler);

// Authenticated — get my referral stats
router.get('/stats', requireAuth, getReferralStatsHandler);

export default router;
