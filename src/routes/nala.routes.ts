import { Router } from 'express';
import { askNalaHandler, getSuggestionsHandler } from '../controllers/nala.controller';

const router = Router();

router.post('/ask', askNalaHandler);
router.get('/suggestions', getSuggestionsHandler);

export default router;
