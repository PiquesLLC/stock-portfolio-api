import { Router } from 'express';
import {
  getSettingsHandler,
  updateSettingsHandler,
  setBaselineHandler,
  setBrokerLifetimeHandler,
  clearBrokerLifetimeHandler,
  getYtdHandler,
  setYtdHandler,
  clearYtdHandler,
  cleanupSnapshotsHandler,
  activateTrackingHandler,
  restartTrackingHandler,
  getCashInterestAccrualHandler,
} from '../controllers/settings.controller';
import { requireAuth, optionalAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

router.get('/', optionalAuth, getSettingsHandler);
router.put('/', mutationLimiter, requireAuth, updateSettingsHandler);
router.post('/baseline', mutationLimiter, requireAuth, setBaselineHandler);
router.post('/broker-lifetime', mutationLimiter, requireAuth, setBrokerLifetimeHandler);
router.delete('/broker-lifetime', mutationLimiter, requireAuth, clearBrokerLifetimeHandler);
router.get('/ytd', optionalAuth, getYtdHandler);
router.post('/ytd', mutationLimiter, requireAuth, setYtdHandler);
router.delete('/ytd', mutationLimiter, requireAuth, clearYtdHandler);
router.post('/cleanup-snapshots', mutationLimiter, requireAuth, cleanupSnapshotsHandler);
router.post('/tracking/activate', mutationLimiter, requireAuth, activateTrackingHandler);
router.post('/tracking/restart', mutationLimiter, requireAuth, restartTrackingHandler);
router.get('/cash-interest/accrual', optionalAuth, getCashInterestAccrualHandler);

export default router;
