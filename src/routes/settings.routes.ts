import { Router } from 'express';
import {
  getSettingsHandler,
  updateSettingsHandler,
  setBaselineHandler,
  setBrokerLifetimeHandler,
  clearBrokerLifetimeHandler,
  cleanupSnapshotsHandler,
} from '../controllers/settings.controller';

const router = Router();

router.get('/', getSettingsHandler);
router.put('/', updateSettingsHandler);
router.post('/baseline', setBaselineHandler);
router.post('/broker-lifetime', setBrokerLifetimeHandler);
router.delete('/broker-lifetime', clearBrokerLifetimeHandler);
router.post('/cleanup-snapshots', cleanupSnapshotsHandler);

export default router;
