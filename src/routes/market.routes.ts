import { Router } from 'express';
import { getPrices, getQuote, getFastQuote, getStockDetails, getIntraday, getHourlyCandles, getDailyCandles, searchSymbols, getBenchmarkClosesHandler, getMarketNews, getTickerNews, getAIEventsHandler, getETFHoldingsHandler, getAssetAboutHandler, askStockQuestionHandler, getHistoricalCAGRHandler, getHeatmapHandler, getNalaScoreHandler, getEarningsTrackHandler } from '../controllers/market.controller';
import { heavyReadLimiter, mutationLimiter } from '../middleware/rateLimiter';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePlan } from '../middleware/plan.middleware';

const router = Router();

router.get('/search', searchSymbols);
router.get('/prices', heavyReadLimiter, getPrices);
router.get('/quote/:ticker', heavyReadLimiter, getQuote);
router.get('/fast-quote/:ticker', getFastQuote);
router.get('/stock/:ticker/details', heavyReadLimiter, getStockDetails);
router.get('/stock/:ticker/intraday', heavyReadLimiter, getIntraday);
router.get('/stock/:ticker/hourly', heavyReadLimiter, getHourlyCandles);
router.get('/stock/:ticker/daily', heavyReadLimiter, getDailyCandles);
router.get('/stock/:ticker/etf-holdings', getETFHoldingsHandler);
router.get('/stock/:ticker/about', getAssetAboutHandler);
router.get('/benchmark/:ticker/closes', getBenchmarkClosesHandler);
router.get('/news', heavyReadLimiter, getMarketNews);
router.get('/stock/:ticker/news', heavyReadLimiter, getTickerNews);
router.get('/stock/:ticker/ai-events', heavyReadLimiter, requireAuth, requirePlan('premium'), getAIEventsHandler);
router.post('/stock/:ticker/ask', mutationLimiter, requireAuth, requirePlan('premium'), askStockQuestionHandler);
router.get('/historical-cagr', heavyReadLimiter, getHistoricalCAGRHandler);
router.get('/heatmap', heavyReadLimiter, getHeatmapHandler);
router.get('/stock/:ticker/nala-score', heavyReadLimiter, requireAuth, requirePlan('pro'), getNalaScoreHandler);
router.get('/stock/:ticker/earnings-track', heavyReadLimiter, getEarningsTrackHandler);

export default router;
