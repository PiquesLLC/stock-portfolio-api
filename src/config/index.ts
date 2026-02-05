import dotenv from 'dotenv';

dotenv.config();

// CRITICAL: Required environment variables
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

// In production, also require API keys
if (process.env.NODE_ENV === 'production') {
  const requiredKeys = ['FINNHUB_API_KEY', 'POLYGON_API_KEY'];
  for (const key of requiredKeys) {
    if (!process.env[key]) {
      console.error(`FATAL: Missing required env var for production: ${key}`);
      process.exit(1);
    }
  }
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  finnhubApiKey: process.env.FINNHUB_API_KEY || '',
  priceCacheTtl: parseInt(process.env.PRICE_CACHE_TTL || '5', 10),
  snapshotIntervalSeconds: parseInt(process.env.SNAPSHOT_INTERVAL_SECONDS || '60', 10),

  // Polygon API settings
  polygonApiKey: process.env.POLYGON_API_KEY || '',
  quoteCacheTtlSeconds: parseInt(process.env.QUOTE_CACHE_TTL_SECONDS || '30', 10),
  repriceThresholdSeconds: parseInt(process.env.REPRICE_THRESHOLD_SECONDS || '30', 10),

  // Projection settings
  sp500CagrTotalReturn: parseFloat(process.env.SP500_CAGR_TOTAL_RETURN || '0.10'), // 10% default
  riskFreeRate: parseFloat(process.env.RISK_FREE_RATE || '0.02'), // 2% default

  // JWT Authentication
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  // CORS - allowed origins for API requests
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174').split(','),
};
