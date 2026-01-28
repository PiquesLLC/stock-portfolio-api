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
} from '../controllers/settings.controller';

const router = Router();

router.get('/', getSettingsHandler);
router.put('/', updateSettingsHandler);
router.post('/baseline', setBaselineHandler);
router.post('/broker-lifetime', setBrokerLifetimeHandler);
router.delete('/broker-lifetime', clearBrokerLifetimeHandler);
router.get('/ytd', getYtdHandler);
router.post('/ytd', setYtdHandler);
router.delete('/ytd', clearYtdHandler);
router.post('/cleanup-snapshots', cleanupSnapshotsHandler);

export default router;
