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
  const billingEnabled = process.env.BILLING_ENABLED !== 'false';
  const plaidEnabled = process.env.PLAID_ENABLED !== 'false';
  const requiredKeys = [
    'FINNHUB_API_KEY',
    'POLYGON_API_KEY',
    'MFA_ENCRYPTION_KEY',
  ];
  if (plaidEnabled) {
    requiredKeys.push('PLAID_CLIENT_ID', 'PLAID_SECRET');
  }
  if (billingEnabled) {
    requiredKeys.push(
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_PRO_MONTHLY_PRICE_ID',
      'STRIPE_PREMIUM_MONTHLY_PRICE_ID'
    );
  }
  for (const key of requiredKeys) {
    if (!process.env[key]) {
      console.error(`FATAL: Missing required env var for production: ${key}`);
      process.exit(1);
    }
  }
}

// Validate MFA encryption key format at startup (must be 64-char hex = 32 bytes for AES-256)
const mfaKey = process.env.MFA_ENCRYPTION_KEY || '';
if (mfaKey && !/^[0-9a-fA-F]{64}$/.test(mfaKey)) {
  console.error('FATAL: MFA_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes for AES-256-GCM)');
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
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
  refreshTokenExpiresInDays: parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS || '30', 10),

  // Alpha Vantage API
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY || process.env.ALPHA_VANTAGE_KEY || '',
  alphaVantageDailyLimit: parseInt(process.env.AV_DAILY_LIMIT || '25', 10),

  // Perplexity API
  perplexityApiKey: process.env.PERPLEXITY_API_KEY || '',

  // MFA
  mfaEncryptionKey: process.env.MFA_ENCRYPTION_KEY || '', // 64-char hex (32 bytes) for AES-256-GCM
  resendApiKey: process.env.RESEND_API_KEY || '',

  // Plaid
  plaidClientId: process.env.PLAID_CLIENT_ID || '',
  plaidSecret: process.env.PLAID_SECRET || '',
  plaidEnv: (process.env.PLAID_ENV || 'sandbox') as 'sandbox' | 'development' | 'production',

  // Stripe billing
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripeProMonthlyPriceId: process.env.STRIPE_PRO_MONTHLY_PRICE_ID || process.env.STRIPE_PRICE_PRO || '',
  stripeProYearlyPriceId: process.env.STRIPE_PRO_YEARLY_PRICE_ID || '',
  stripePremiumMonthlyPriceId: process.env.STRIPE_PREMIUM_MONTHLY_PRICE_ID || process.env.STRIPE_PRICE_PREMIUM || '',
  stripePremiumYearlyPriceId: process.env.STRIPE_PREMIUM_YEARLY_PRICE_ID || '',
  stripeReturnUrl: process.env.STRIPE_RETURN_URL || 'http://localhost:5173/settings/billing',
  billingEnabled: process.env.BILLING_ENABLED !== 'false',

  // CORS - allowed origins for API requests
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174,capacitor://localhost,http://localhost').split(','),

  // Rate limiting
  rateLimit: {
    login: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxAttempts: process.env.NODE_ENV === 'production' ? 10 : 50,
    },
    setPassword: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxAttempts: 3,
    },
    signup: {
      windowMs: 60 * 60 * 1000, // 1 hour
      maxAttempts: 5,
    },
    mutation: {
      windowMs: 60 * 1000, // 1 minute
      maxAttempts: 30,
    },
    api: {
      windowMs: 60 * 1000, // 1 minute
      maxAttempts: process.env.NODE_ENV === 'production' ? 200 : 1000,
    },
    mfaVerify: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxAttempts: process.env.NODE_ENV === 'production' ? 5 : 50,
    },
    mfaSend: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxAttempts: process.env.NODE_ENV === 'production' ? 3 : 20,
    },
  },

  // Cookie options for auth token clearing
  clearCookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
  },
};
