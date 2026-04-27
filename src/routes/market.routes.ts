import { Router } from 'express';
import { getPrices, getQuote, getFastQuote, getStockDetails, getIntraday, getHourlyCandles, getDailyCandles, getCandles, searchSymbols, getBenchmarkClosesHandler, getMarketNews, getTickerNews, getAIEventsHandler, getETFHoldingsHandler, getAssetAboutHandler, askStockQuestionHandler, getHistoricalCAGRHandler, getHeatmapHandler, getMarketScreenerHandler, getNalaScoreHandler, getEarningsTrackHandler, getThemesHeatmapHandler, getEtfHeatmapHandler, getMarketSentimentHandler, getValueRadarHandler } from '../controllers/market.controller';
import { getSectorPerformanceHandler } from '../controllers/sector-performance.controller';
import { heavyReadLimiter, mutationLimiter } from '../middleware/rateLimiter';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePlan } from '../middleware/plan.middleware';
const router = Router();

router.get('/search', searchSymbols);
router.get('/prices', heavyReadLimiter, getPrices);
router.get('/quote/:ticker', heavyReadLimiter, getQuote);
router.get('/fast-quote/:ticker', heavyReadLimiter, getFastQuote);
router.get('/stock/:ticker/details', heavyReadLimiter, getStockDetails);
router.get('/stock/:ticker/intraday', heavyReadLimiter, getIntraday);
router.get('/stock/:ticker/hourly', heavyReadLimiter, getHourlyCandles);
router.get('/stock/:ticker/daily', heavyReadLimiter, getDailyCandles);
router.get('/stock/:ticker/candles', heavyReadLimiter, getCandles);
router.get('/stock/:ticker/etf-holdings', heavyReadLimiter, getETFHoldingsHandler);
router.get('/stock/:ticker/about', heavyReadLimiter, getAssetAboutHandler);
router.get('/benchmark/:ticker/closes', getBenchmarkClosesHandler);
router.get('/news', heavyReadLimiter, getMarketNews);
router.get('/stock/:ticker/news', heavyReadLimiter, getTickerNews);
router.get('/stock/:ticker/ai-events', heavyReadLimiter, requireAuth, requirePlan('premium'), getAIEventsHandler);
router.post('/stock/:ticker/ask', mutationLimiter, requireAuth, requirePlan('premium'), askStockQuestionHandler);
router.get('/historical-cagr', heavyReadLimiter, getHistoricalCAGRHandler);
router.get('/heatmap', heavyReadLimiter, getHeatmapHandler);
router.get('/screener', heavyReadLimiter, getMarketScreenerHandler);
router.get('/sentiment', heavyReadLimiter, getMarketSentimentHandler);
router.get('/sectors/performance', heavyReadLimiter, getSectorPerformanceHandler);
router.get('/themes/heatmap', heavyReadLimiter, getThemesHeatmapHandler);
router.get('/etf/heatmap', heavyReadLimiter, getEtfHeatmapHandler);
router.get('/stock/:ticker/nala-score', heavyReadLimiter, requireAuth, requirePlan('pro'), getNalaScoreHandler);
router.get('/stock/:ticker/earnings-track', heavyReadLimiter, getEarningsTrackHandler);
router.get('/value-radar', heavyReadLimiter, getValueRadarHandler);
router.get('/economic-calendar', heavyReadLimiter, async (_req, res) => {
  try {
    const { getUpcomingEconomicEvents } = await import('../services/economic-calendar.service');
    const events = await getUpcomingEconomicEvents();
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch economic calendar' });
  }
});

export default router;
