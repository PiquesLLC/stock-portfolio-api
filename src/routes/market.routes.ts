import { Router } from 'express';
import { getPrices, getQuote, searchSymbols } from '../controllers/market.controller';

const router = Router();

router.get('/search', searchSymbols);
router.get('/prices', getPrices);
router.get('/quote/:ticker', getQuote);

export default router;
