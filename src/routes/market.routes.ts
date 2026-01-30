import { Router } from 'express';
import { getPrices, getQuote, getStockDetails, getIntraday, searchSymbols, getBenchmarkClosesHandler } from '../controllers/market.controller';

const router = Router();

router.get('/search', searchSymbols);
router.get('/prices', getPrices);
router.get('/quote/:ticker', getQuote);
router.get('/stock/:ticker/details', getStockDetails);
router.get('/stock/:ticker/intraday', getIntraday);
router.get('/benchmark/:ticker/closes', getBenchmarkClosesHandler);

export default router;
