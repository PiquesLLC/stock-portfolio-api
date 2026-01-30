import { Router } from 'express';
import {
  getAlertsHandler,
  updateAlertHandler,
  getEventsHandler,
  getUnreadCountHandler,
  markReadHandler,
  markAllReadHandler,
} from '../controllers/alert.controller';

const router = Router();

router.get('/', getAlertsHandler);
router.put('/:id', updateAlertHandler);
router.get('/events', getEventsHandler);
router.get('/events/unread-count', getUnreadCountHandler);
router.post('/events/:id/read', markReadHandler);
router.post('/events/read-all', markAllReadHandler);

export default router;
