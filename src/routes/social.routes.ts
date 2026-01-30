import { Router } from 'express';
import { getFeedHandler } from '../controllers/social.controller';

const router = Router();

router.get('/feed', getFeedHandler);

export default router;
