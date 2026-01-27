import { Router } from 'express';
import { getPrices, getQuote } from '../controllers/market.controller';

const router = Router();

router.get('/prices', getPrices);
router.get('/quote/:ticker', getQuote);

export default router;
