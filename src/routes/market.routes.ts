import { Router } from 'express';
import { getPrices, getQuote, getStockDetails, getIntraday, searchSymbols } from '../controllers/market.controller';

const router = Router();

router.get('/search', searchSymbols);
router.get('/prices', getPrices);
router.get('/quote/:ticker', getQuote);
router.get('/stock/:ticker/details', getStockDetails);
router.get('/stock/:ticker/intraday', getIntraday);

export default router;
