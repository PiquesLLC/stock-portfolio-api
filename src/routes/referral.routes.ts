import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { getReferralStatsHandler, validateReferralCodeHandler } from '../controllers/referral.controller';

const router = Router();

// Public — validate a referral code
router.get('/validate/:code', validateReferralCodeHandler);

// Authenticated — get my referral stats
router.get('/stats', requireAuth, getReferralStatsHandler);

export default router;
