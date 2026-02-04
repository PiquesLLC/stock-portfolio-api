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
} from '../controllers/settings.controller';
import { requireAuth, optionalAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/', optionalAuth, getSettingsHandler);
router.put('/', requireAuth, updateSettingsHandler);
router.post('/baseline', requireAuth, setBaselineHandler);
router.post('/broker-lifetime', requireAuth, setBrokerLifetimeHandler);
router.delete('/broker-lifetime', requireAuth, clearBrokerLifetimeHandler);
router.get('/ytd', optionalAuth, getYtdHandler);
router.post('/ytd', requireAuth, setYtdHandler);
router.delete('/ytd', requireAuth, clearYtdHandler);
router.post('/cleanup-snapshots', requireAuth, cleanupSnapshotsHandler);
router.post('/tracking/activate', requireAuth, activateTrackingHandler);
router.post('/tracking/restart', requireAuth, restartTrackingHandler);

export default router;
