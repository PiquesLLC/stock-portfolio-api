import { Router } from 'express';
import { getPrices, getQuote, getStockDetails, getIntraday, getHourlyCandles, searchSymbols, getBenchmarkClosesHandler } from '../controllers/market.controller';

const router = Router();

router.get('/search', searchSymbols);
router.get('/prices', getPrices);
router.get('/quote/:ticker', getQuote);
router.get('/stock/:ticker/details', getStockDetails);
router.get('/stock/:ticker/intraday', getIntraday);
router.get('/stock/:ticker/hourly', getHourlyCandles);
router.get('/benchmark/:ticker/closes', getBenchmarkClosesHandler);

export default router;
