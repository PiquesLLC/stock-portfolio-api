import { Router } from 'express';
import { getPrices, getQuote, getFastQuote, getStockDetails, getIntraday, getHourlyCandles, searchSymbols, getBenchmarkClosesHandler, getMarketNews, getTickerNews, getAIEventsHandler, getETFHoldingsHandler, getAssetAboutHandler, askStockQuestionHandler, getHistoricalCAGRHandler } from '../controllers/market.controller';

const router = Router();

router.get('/search', searchSymbols);
router.get('/prices', getPrices);
router.get('/quote/:ticker', getQuote);
router.get('/fast-quote/:ticker', getFastQuote);
router.get('/stock/:ticker/details', getStockDetails);
router.get('/stock/:ticker/intraday', getIntraday);
router.get('/stock/:ticker/hourly', getHourlyCandles);
router.get('/stock/:ticker/etf-holdings', getETFHoldingsHandler);
router.get('/stock/:ticker/about', getAssetAboutHandler);
router.get('/benchmark/:ticker/closes', getBenchmarkClosesHandler);
router.get('/news', getMarketNews);
router.get('/stock/:ticker/news', getTickerNews);
router.get('/stock/:ticker/ai-events', getAIEventsHandler);
router.post('/stock/:ticker/ask', askStockQuestionHandler);
router.get('/historical-cagr', getHistoricalCAGRHandler);

export default router;
