import dotenv from 'dotenv';

// Load env from NALA_ENV_FILE when set, so the local .env can live OUTSIDE the
// cloud-synced project folder (it previously held live secrets on OneDrive). In
// prod (Railway) NALA_ENV_FILE is unset and vars are injected directly, so this
// falls through to the default ./.env behavior, unchanged.
if (process.env.NALA_ENV_FILE) {
  dotenv.config({ path: process.env.NALA_ENV_FILE });
  console.log(`[env] loaded from NALA_ENV_FILE=${process.env.NALA_ENV_FILE}`);
} else {
  dotenv.config();
}

/** Parse a numeric env var, falling back if unset or non-numeric (so a typo'd
 *  value can't silently disable a safety cap). */
function numEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// CRITICAL: Required environment variables
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}
// A short JWT_SECRET weakens HS256 signing — a brute-forceable secret means
// forgeable tokens, i.e. full auth bypass (impersonate any user). In PRODUCTION
// that is worse than a boot failure, so refuse to start rather than serve
// forgeable tokens; prod's secret is a 64-byte hex today, so this only guards
// against a future misconfiguration (a fat-fingered env var). Outside production
// we keep warning, since local dev may legitimately use a short secret.
// 32 chars ≈ the practical floor.
if (jwtSecret.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    console.error(`FATAL: JWT_SECRET is only ${jwtSecret.length} chars — production requires >=32 (ideally a 64-byte hex). Refusing to boot with a forgeable signing key.`);
    process.exit(1);
  }
  console.error(`WARNING: JWT_SECRET is only ${jwtSecret.length} chars — recommend >=32 (ideally a 64-byte hex). Token signing is weak until rotated.`);
}

// In production, also require API keys
if (process.env.NODE_ENV === 'production') {
  const billingEnabled = process.env.BILLING_ENABLED !== 'false';
  const creatorMonetizationEnabled = process.env.CREATOR_MONETIZATION_ENABLED === 'true';
  const plaidEnabled = process.env.PLAID_ENABLED !== 'false';
  const requiredKeys = [
    'FINNHUB_API_KEY',
    'POLYGON_API_KEY',
    'MFA_ENCRYPTION_KEY',
    // Without Resend, verification/reset emails silently fall through to a
    // dev-mode path instead of sending — fail closed at boot in prod.
    'RESEND_API_KEY',
  ];
  if (process.env.APPLE_IAP_ENABLED === 'true') {
    // The App Store server-notification verifier requires the numeric app ID
    // in production — fail fast at boot rather than at the first webhook.
    requiredKeys.push('APPLE_APP_APPLE_ID');
  }
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
  if (creatorMonetizationEnabled) {
    requiredKeys.push(
      'STRIPE_SECRET_KEY',
      'STRIPE_CONNECT_WEBHOOK_SECRET'
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

// bcrypt cost (work factor). Passwords are hashed ONCE per login/signup so a
// higher cost is affordable and meaningfully slows offline cracking; OTP / backup
// codes are short-lived AND generateBackupCodes() hashes 10 in a loop, so they
// stay at the cheaper cost to keep that path responsive. bcryptjs is pure-JS and
// single-threaded, so cost 12 is ~4x the work of cost 10.
//
// Tests drop BOTH to the bcrypt minimum (4): round-trip correctness is what the
// suite verifies, not the work factor, and cost 12 in a loop would dominate
// CI time. We honor the repo's existing test-detection convention — the test
// setup sets NODE_ENV='development', and vitest exports VITEST='true' — see
// email.service.ts / etf-heatmap.service.ts for the same guard.
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
// Floor the non-test cost at 10 so a blank/typo'd env override (e.g. "" -> 0)
// can't silently drop hashing below the prior baseline; it can only tune upward.
const bcryptSaltRounds = isTestEnv ? 4 : Math.max(10, numEnv(process.env.BCRYPT_SALT_ROUNDS, 12));
const bcryptOtpSaltRounds = isTestEnv ? 4 : Math.max(10, numEnv(process.env.BCRYPT_OTP_SALT_ROUNDS, 10));

export const config = {
  // 3001 matches the UI dev proxy (vite.config.ts) and scripts/kill-port.js —
  // a 3000 default left a fresh clone's UI proxying at a port nothing listens on.
  // Prod is unaffected: Railway always injects PORT explicitly.
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  finnhubApiKey: process.env.FINNHUB_API_KEY || '',
  fmpApiKey: process.env.FMP_API_KEY || '',
  priceCacheTtl: parseInt(process.env.PRICE_CACHE_TTL || '5', 10),
  snapshotIntervalSeconds: parseInt(process.env.SNAPSHOT_INTERVAL_SECONDS || '60', 10),

  // Disk self-healing guard (SQLite volume at /data)
  diskWarnPct: parseInt(process.env.DISK_WARN_PCT || '80', 10),
  diskCriticalPct: parseInt(process.env.DISK_CRITICAL_PCT || '90', 10),
  diskGuardIntervalMs: parseInt(process.env.DISK_GUARD_INTERVAL_MS || '600000', 10),
  diskAlertCooldownMs: parseInt(process.env.DISK_ALERT_COOLDOWN_MS || '21600000', 10),

  // Polygon API settings
  polygonApiKey: process.env.POLYGON_API_KEY || '',
  quoteCacheTtlSeconds: parseInt(process.env.QUOTE_CACHE_TTL_SECONDS || '30', 10),
  repriceThresholdSeconds: parseInt(process.env.REPRICE_THRESHOLD_SECONDS || '30', 10),
  quoteRefreshIntervalMs: parseInt(process.env.QUOTE_REFRESH_INTERVAL_MS || '30000', 10),
  maxRefreshTickers: parseInt(process.env.MAX_REFRESH_TICKERS || '500', 10),

  // Projection settings
  sp500CagrTotalReturn: parseFloat(process.env.SP500_CAGR_TOTAL_RETURN || '0.10'), // 10% default
  // (risk-free rate is canonical in finance-math.RISK_FREE_RATE = 0; all Sharpe
  //  ratios share it via finance-math.sharpeRatio so screens can't disagree.)

  // bcrypt work factors — passwords (12) vs OTP/backup codes (10); both 4 in tests.
  bcryptSaltRounds,
  bcryptOtpSaltRounds,

  // JWT Authentication
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  // 30 days. Refresh tokens slide on every rotation, so for active users this
  // is effectively a never-expiring session. The hard cap only matters for
  // users idle for the full window. Kept at 30d (not bumped) to avoid widening
  // the blast radius of any stolen refresh token; the rotation-cache fix is
  // what stops deploy-driven signouts.
  refreshTokenExpiresInDays: parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS || '30', 10),

  // Alpha Vantage API
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY || process.env.ALPHA_VANTAGE_KEY || '',
  alphaVantageDailyLimit: parseInt(process.env.AV_DAILY_LIMIT || '25', 10),

  // Perplexity API
  perplexityApiKey: process.env.PERPLEXITY_API_KEY || '',

  // AI provider toggle: 'perplexity' | 'gemini' — controls which provider briefing/daily-report/behavior/events/qa use
  aiProvider: (process.env.AI_PROVIDER || 'perplexity') as 'perplexity' | 'gemini',

  // AI spend circuit breaker (M6). A platform-wide backstop against runaway or
  // abusive LLM spend — sized ABOVE normal usage; tune down once you know your
  // baseline from the admin cost dashboard. Trips on EITHER a rolling-24h USD
  // cap or a call-count cap (the count catches providers whose per-call cost
  // logs as ~$0, e.g. Gemini). `AI_DISABLED=true` is an instant kill switch.
  aiSpendBreakerEnabled: process.env.AI_SPEND_BREAKER_ENABLED !== 'false', // default ON
  aiDailyCostCapUsd: numEnv(process.env.AI_DAILY_COST_CAP_USD, 100),
  aiDailyCallCap: numEnv(process.env.AI_DAILY_CALL_CAP, 10000),
  aiHardDisabled: process.env.AI_DISABLED === 'true', // emergency kill switch

  // MFA
  mfaEncryptionKey: process.env.MFA_ENCRYPTION_KEY || '', // 64-char hex (32 bytes) for AES-256-GCM
  resendApiKey: process.env.RESEND_API_KEY || '',
  resendFromEmail: process.env.RESEND_FROM_EMAIL || 'noreply@nalaai.com',
  emailVerificationEnabled: process.env.EMAIL_VERIFICATION_ENABLED !== 'false',

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
  stripeEliteMonthlyPriceId: process.env.STRIPE_ELITE_MONTHLY_PRICE_ID || '',
  stripeEliteYearlyPriceId: process.env.STRIPE_ELITE_YEARLY_PRICE_ID || '',
  stripeReturnUrl: process.env.STRIPE_RETURN_URL || 'http://localhost:5173',
  stripeConnectWebhookSecret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '',
  billingEnabled: process.env.BILLING_ENABLED !== 'false',
  creatorMonetizationEnabled: process.env.CREATOR_MONETIZATION_ENABLED === 'true',
  // Emergency kill switch — disabled until C1 (destination-charges + manual-transfer
  // double-payout) and C4 (no dispute clawback on creator ledger) are fixed.
  // Re-enable with CREATOR_PAYOUTS_ENABLED=true after audit remediation lands.
  creatorPayoutsEnabled: process.env.CREATOR_PAYOUTS_ENABLED === 'true',
  payoutMinCents: parseInt(process.env.PAYOUT_MIN_CENTS || '5000', 10),
  creatorAdminUserIds: (process.env.CREATOR_ADMIN_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  waitlistAdminUserIds: (process.env.WAITLIST_ADMIN_USER_IDS || process.env.CREATOR_ADMIN_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  waitlistEnabled: process.env.WAITLIST_ENABLED === 'true',
  waitlistNotifyEmail: process.env.WAITLIST_NOTIFY_EMAIL || '',
  waitlistAdminEmails: (process.env.WAITLIST_ADMIN_EMAILS || process.env.WAITLIST_NOTIFY_EMAIL || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  appFrontendUrl: process.env.APP_FRONTEND_URL || process.env.STRIPE_RETURN_URL || 'https://nalaai.com',

  // H4 origin lockdown (rate-limit IP trust). When set, the rate limiter trusts
  // the `CF-Connecting-IP` header ONLY on requests that also carry a matching
  // `X-Origin-Auth` header — injected by a Cloudflare Transform Rule that an
  // attacker hitting the Railway origin directly cannot forge. Unset (default)
  // preserves the legacy behavior of always trusting CF-Connecting-IP, so
  // deploying this is inert until BOTH the edge rule and this secret are set.
  // ⚠️ Set the Cloudflare rule FIRST, verify the header arrives, THEN set this —
  // otherwise legitimate traffic loses its per-client key. See
  // docs/H4-origin-lockdown.md.
  cloudflareOriginSecret: process.env.CLOUDFLARE_ORIGIN_SECRET || '',
  testerFeatureAccessUsernames: (process.env.TESTER_FEATURE_ACCESS_USERNAMES || '')
    .split(',')
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean),

  // NALA AI Deep Research (Gemini)
  googleGeminiApiKey: process.env.GOOGLE_GEMINI_API_KEY || '',
  deepResearchEnabled: process.env.DEEP_RESEARCH_ENABLED === 'true',
  deepResearchMaxConcurrent: parseInt(process.env.DEEP_RESEARCH_MAX_CONCURRENT || '1', 10),
  deepResearchMonthlyLimit: parseInt(process.env.DEEP_RESEARCH_MONTHLY_LIMIT || '10', 10),
  deepResearchPollIntervalMs: parseInt(process.env.DEEP_RESEARCH_POLL_INTERVAL_MS || '15000', 10),

  // Web Push Notifications (VAPID)
  pushEnabled: process.env.PUSH_ENABLED === 'true',
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:contact@nalaai.com',

  // APNs Native Push (iOS)
  apnsKeyId: process.env.APNS_KEY_ID || process.env.APPLE_KEY_ID || '',
  apnsTeamId: process.env.APNS_TEAM_ID || process.env.APPLE_TEAM_ID || '',
  apnsPrivateKey: (process.env.APNS_PRIVATE_KEY || process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  apnsBundleId: process.env.APNS_BUNDLE_ID || 'com.nala.portfolio',

  // Apple IAP
  appleIapEnabled: process.env.APPLE_IAP_ENABLED === 'true',
  appleBundleId: process.env.APPLE_BUNDLE_ID || 'com.nala.portfolio',
  // Numeric App Store app ID — required to verify PRODUCTION server
  // notifications (the library matches it against the payload's appAppleId).
  appleAppAppleId: process.env.APPLE_APP_APPLE_ID ? Number(process.env.APPLE_APP_APPLE_ID) : undefined,
  appleIapSharedSecret: process.env.APPLE_IAP_SHARED_SECRET || '',

  // OAuth
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  appleClientId: process.env.APPLE_CLIENT_ID || '',
  appleTeamId: process.env.APPLE_TEAM_ID || '',
  appleKeyId: process.env.APPLE_KEY_ID || '',
  applePrivateKey: (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),

  // CORS - native schemes always allowed; localhost only in development
  allowedOrigins: Array.from(new Set([
    // Native app schemes (always needed for Capacitor)
    'capacitor://localhost',
    'ionic://localhost',
    'app://localhost',
    // Local dev origins only in non-production
    ...(process.env.NODE_ENV !== 'production' ? [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:5174',
      'https://localhost',
      'http://localhost:8080',
      'http://localhost',
    ] : []),
    ...((process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean)),
  ])),

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
    waitlistJoin: {
      windowMs: 60 * 60 * 1000, // 1 hour
      maxAttempts: process.env.NODE_ENV === 'production' ? 5 : 50,
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

  // Sentry error monitoring
  sentryDsn: process.env.SENTRY_DSN || '',

  // Cookie options for auth token clearing
  clearCookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
  },
};
