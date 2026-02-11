import { Router } from 'express';
import { getPrices, getQuote, getFastQuote, getStockDetails, getIntraday, getHourlyCandles, searchSymbols, getBenchmarkClosesHandler, getMarketNews, getTickerNews, getAIEventsHandler, getETFHoldingsHandler, getAssetAboutHandler, askStockQuestionHandler, getHistoricalCAGRHandler } from '../controllers/market.controller';
import { heavyReadLimiter } from '../middleware/rateLimiter';

const router = Router();

router.get('/search', searchSymbols);
router.get('/prices', heavyReadLimiter, getPrices);
router.get('/quote/:ticker', heavyReadLimiter, getQuote);
router.get('/fast-quote/:ticker', getFastQuote);
router.get('/stock/:ticker/details', heavyReadLimiter, getStockDetails);
router.get('/stock/:ticker/intraday', heavyReadLimiter, getIntraday);
router.get('/stock/:ticker/hourly', heavyReadLimiter, getHourlyCandles);
router.get('/stock/:ticker/etf-holdings', getETFHoldingsHandler);
router.get('/stock/:ticker/about', getAssetAboutHandler);
router.get('/benchmark/:ticker/closes', getBenchmarkClosesHandler);
router.get('/news', heavyReadLimiter, getMarketNews);
router.get('/stock/:ticker/news', heavyReadLimiter, getTickerNews);
router.get('/stock/:ticker/ai-events', heavyReadLimiter, getAIEventsHandler);
router.post('/stock/:ticker/ask', askStockQuestionHandler);
router.get('/historical-cagr', heavyReadLimiter, getHistoricalCAGRHandler);

export default router;
