import { Router } from 'express';
import {
  getAnalystEventsHandler,
  getUnreadAnalystCountHandler,
  markAnalystEventReadHandler,
  markAllAnalystEventsReadHandler,
  getAnalystSnapshotHandler,
} from '../controllers/analyst.controller';

const router = Router();

// Events
router.get('/events', getAnalystEventsHandler);
router.get('/events/unread-count', getUnreadAnalystCountHandler);
router.post('/events/:id/read', markAnalystEventReadHandler);
router.post('/events/read-all', markAllAnalystEventsReadHandler);

// Snapshots
router.get('/snapshot/:ticker', getAnalystSnapshotHandler);

export default router;
