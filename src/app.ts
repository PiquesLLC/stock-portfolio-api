import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import routes from './routes';
import { config } from './config';
import { apiLimiter } from './middleware/rateLimiter';
import prisma from './utils/prisma';

// Initialize Sentry before Express app (must be first)
if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    tracesSampleRate: config.nodeEnv === 'production' ? 0.1 : 1.0,
    beforeSend(event) {
      // Strip sensitive headers from request context
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['cookie'];
        delete event.request.headers['x-goog-api-key'];
      }
      // Strip API keys from exception stack frames and breadcrumb data
      // that Axios may embed in error objects (config.url, request.path)
      if (event.exception?.values) {
        for (const ex of event.exception.values) {
          if (ex.value) {
            ex.value = ex.value.replace(/[?&]key=[^&\s]+/gi, '?key=[REDACTED]');
          }
        }
      }
      if (event.breadcrumbs) {
        for (const bc of event.breadcrumbs) {
          if (bc.data && typeof bc.data === 'object') {
            for (const key of Object.keys(bc.data)) {
              if (typeof bc.data[key] === 'string' && /[?&]key=[^&\s]+/i.test(bc.data[key])) {
                bc.data[key] = bc.data[key].replace(/[?&]key=[^&\s]+/gi, '?key=[REDACTED]');
              }
            }
          }
        }
      }
      return event;
    },
  });
}

const app = express();
const SOCIAL_CRAWLER_RE = /(Twitterbot|facebookexternalhit|Discordbot|TelegramBot|LinkedInBot|Slackbot|WhatsApp)/i;
const RESERVED_TOP_LEVEL_PATHS = new Set([
  'auth',
  'health',
  'market',
  'portfolios',
  'portfolio',
  'dividends',
  'settings',
  'insights',
  'goals',
  'intelligence',
  'leaderboard',
  'users',
  'social',
  'transactions',
  'alerts',
  'price-alerts',
  'analyst',
  'milestones',
  'fundamentals',
  'nala',
  'watchlists',
  'stock-follows',
  'creator',
  'referral',
  'waitlist',
  'notifications',
  'push',
  'plaid',
  'billing',
  'assets',
  'privacy',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
]);

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildOgMetaTags(input: {
  title: string;
  description: string;
  image: string;
  url: string;
  twitterCard: string;
  twitterSite?: string;
}): string {
  const twitterSiteTag = input.twitterSite
    ? `<meta name="twitter:site" content="${escapeHtmlAttr(input.twitterSite)}">`
    : '';

  return `<!-- Nala OG Tags -->
<meta property="og:title" content="${escapeHtmlAttr(input.title)}">
<meta property="og:description" content="${escapeHtmlAttr(input.description)}">
<meta property="og:image" content="${escapeHtmlAttr(input.image)}">
<meta property="og:url" content="${escapeHtmlAttr(input.url)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="${escapeHtmlAttr(input.twitterCard)}">
${twitterSiteTag}
<!-- /Nala OG Tags -->`;
}

function injectMetaTags(html: string, ogTags: string): string {
  if (!html) return html;
  return html.includes('</head>')
    ? html.replace('</head>', `${ogTags}\n</head>`)
    : `${ogTags}\n${html}`;
}

// Trust reverse proxy (Railway, Heroku, etc.) for correct IP detection in rate limiting
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Security headers (CSP, X-Frame-Options, etc.)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.plaid.com", "https://static.cloudflareinsights.com", "https://accounts.google.com", "https://appleid.cdn-apple.com"],
      // NOTE: The UI's index.html also has a CSP <meta> tag. Both must be kept in sync.
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", ...config.allowedOrigins, "https://cdn.plaid.com", "https://*.plaid.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      workerSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", "blob:", "https:"],
      frameSrc: ["https://cdn.plaid.com"],
    },
  },
  // HSTS: enforce HTTPS for 1 year, include subdomains
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
  },
  // Allow popups (Apple/Google Sign-In) to communicate back via window.opener
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));

// CORS configuration - locked down to specific origins
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (same-origin in production, mobile apps, Postman in dev)
    if (!origin) {
      return callback(null, true);
    }
    if (config.allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // In development, allow LAN origins (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    if (config.nodeEnv === 'development') {
      const lanRe = /^https?:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;
      if (lanRe.test(origin)) {
        return callback(null, true);
      }
    }
    callback(new Error(`CORS not allowed for origin: ${origin}`));
  },
  credentials: true, // Required for cookies
}));

app.use(cookieParser());

// CSRF protection for cookie-authenticated mutations (POST, PUT, DELETE, PATCH).
// Checks that the Origin header matches allowed origins for requests that rely on
// cookie-based auth. Bearer-token requests (native iOS app) and webhook routes
// (which use signature verification) are exempt.
app.use((req, res, next) => {
  // Only check state-changing methods
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  // Skip webhook routes — they use their own signature verification
  if (req.path === '/billing/webhook' || req.path === '/creator/webhooks/stripe' || req.path === '/billing/apple-webhook') {
    return next();
  }

  // Skip requests with Bearer token (native iOS app uses bearer tokens, not cookies)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return next();
  }

  // Only enforce for cookie-authenticated requests (have a cookie but no Authorization header)
  const hasCookie = !!(req.cookies?.authToken || req.cookies?.refreshToken);
  if (!hasCookie) {
    return next();
  }

  // Check Origin header against allowed origins
  const origin = req.headers.origin;
  if (!origin) {
    // No Origin header on a cookie-based mutation — block it.
    // Same-origin requests from browsers always send Origin on POST/PUT/DELETE/PATCH.
    res.status(403).json({ error: 'Forbidden: missing Origin header' });
    return;
  }

  if (!config.allowedOrigins.includes(origin)) {
    res.status(403).json({ error: 'Forbidden: origin not allowed' });
    return;
  }

  next();
});
const jsonParser = express.json({
  limit: '5mb',
  // Capture raw body for webhook signature verification (Plaid)
  verify: (req: any, _res, buf) => {
    req.rawBody = buf.toString('utf-8');
  },
});
app.use((req, res, next) => {
  // Stripe webhook uses route-level express.raw() for signature verification.
  if (req.path === '/billing/webhook' || req.path === '/creator/webhooks/stripe' || req.path === '/billing/apple-webhook') {
    next();
    return;
  }
  jsonParser(req, res, next);
});

// Request timing — log slow requests (>3s) for diagnostics
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (duration > 3000) {
      console.warn(`[SlowRequest] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// Global rate limiting - 100 requests per minute
app.use(apiLimiter);

// Read-only mode: block all non-GET requests (for remote viewers)
if (process.env.READ_ONLY === 'true') {
  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      res.status(403).json({ error: 'Read-only mode: modifications are disabled' });
      return;
    }
    next();
  });
}

// Public privacy policy page (standalone HTML — no auth required)
app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy — Nala by Piques LLC</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:720px;margin:0 auto;padding:2rem 1rem;color:#333;line-height:1.7}
h1{color:#00c805;font-size:1.6rem}h2{margin-top:2rem;font-size:1.1rem}ul{padding-left:1.2rem}a{color:#00c805}
.meta{color:#888;font-size:.85rem;margin-bottom:2rem}</style></head><body>
<h1>Privacy Policy</h1><p class="meta">Last updated: February 15, 2026 &middot; Piques LLC</p>

<h2>1. Information We Collect</h2>
<p>We collect information you provide directly:</p>
<ul><li><strong>Account info</strong>: username, display name, email address</li>
<li><strong>Portfolio data</strong>: stock holdings, shares, cost basis (entered manually or via CSV import)</li>
<li><strong>Linked brokerage data</strong>: via Plaid — account names, types, and last 4 digits only. We never see your brokerage login credentials.</li>
<li><strong>Usage data</strong>: pages viewed, features used, device/browser type</li></ul>

<h2>2. How We Use Your Data</h2>
<ul><li>Display your portfolio, charts, and analytics</li>
<li>Provide AI-powered insights (briefings, behavior coaching, Q&amp;A)</li>
<li>Calculate dividends, projections, and Nala Score</li>
<li>Send alerts (price, earnings) if enabled</li></ul>

<h2>3. Third-Party Services</h2>
<p>We integrate with:</p>
<ul><li><strong>Plaid</strong> — brokerage account linking. Your credentials go directly to Plaid; we only receive account metadata and holdings. Plaid's use of data is governed by <a href="https://plaid.com/legal/#end-user-privacy-policy">Plaid's privacy policy</a>.</li>
<li><strong>Polygon, Finnhub, Alpha Vantage</strong> — market data providers (no user data shared)</li>
<li><strong>Perplexity AI</strong> — AI-powered insights (ticker symbols only, no personal data)</li>
<li><strong>Resend</strong> — email delivery for MFA codes (email address only)</li></ul>

<h2>4. Cookies & Authentication</h2>
<p>We use httpOnly secure cookies for authentication tokens. We do not use tracking cookies or third-party analytics.</p>

<h2>5. Data Retention</h2>
<p>Your data is retained as long as your account is active. Portfolio snapshots are kept for historical chart display. Upon account deletion, all your data is permanently and immediately removed — there is no soft delete or recovery period.</p>

<h2>6. Your Rights</h2>
<ul><li><strong>Access</strong>: View all your data in the app</li>
<li><strong>Export</strong>: Download portfolio data as CSV from Settings</li>
<li><strong>Correction</strong>: Edit your holdings and profile at any time</li>
<li><strong>Deletion</strong>: Permanently delete your account and all data from Settings</li></ul>

<h2>7. Data Security</h2>
<ul><li>Passwords are hashed using bcrypt — we never store or see your plaintext password</li>
<li>Plaid access tokens are encrypted at rest using AES-256-GCM</li>
<li>MFA secrets are encrypted at rest</li>
<li>All connections use HTTPS with TLS 1.2+ and HSTS</li></ul>

<h2>8. Children's Privacy</h2>
<p>Nala is not intended for users under 18. We do not knowingly collect data from children.</p>

<h2>9. Changes to This Policy</h2>
<p>We may update this policy periodically. Continued use of the app after changes constitutes acceptance.</p>

<h2>10. Contact</h2>
<p>Questions or requests? Email <a href="mailto:privacy@piques.io">privacy@piques.io</a></p>
<p style="margin-top:2rem;color:#888;font-size:.8rem">&copy; 2026 Piques LLC. All rights reserved.</p>
</body></html>`);
});

app.use('/', routes);

// In production, serve the UI static files from client/ directory
const clientDir = path.join(__dirname, '..', 'client');
if (fs.existsSync(clientDir)) {
  const indexPath = path.join(clientDir, 'index.html');
  let cachedIndexHtml = '';
  try {
    cachedIndexHtml = fs.readFileSync(indexPath, 'utf-8');
  } catch (error) {
    console.error('[SPA] Failed to read index.html for OG injection:', error);
  }

  // Hashed assets (Vite fingerprints filenames) cache aggressively
  app.use('/assets', express.static(path.join(clientDir, 'assets'), { maxAge: '1y', immutable: true }));
  // Other static files (favicon, icons) short cache, but NEVER serve index.html from here
  app.use(express.static(clientDir, { maxAge: '1h', etag: true, index: false }));
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' || !cachedIndexHtml) {
      next();
      return;
    }

    const defaultOg: Parameters<typeof buildOgMetaTags>[0] = {
      title: 'Nala - Portfolio Intelligence Platform',
      description: 'Track, analyze, and share your investment portfolio with AI-powered insights',
      image: 'https://nalaai.com/og-default.png',
      url: 'https://nalaai.com',
      twitterCard: 'summary_large_image',
    };
    let og = defaultOg;

    try {
      const ua = req.get('user-agent') ?? '';
      const isCrawler = SOCIAL_CRAWLER_RE.test(ua);
      const match = req.path.match(/^\/([^/]+)\/?$/);

      if (isCrawler && match) {
        const segment = decodeURIComponent(match[1]).trim();
        const normalized = segment.toLowerCase();
        const isReserved = RESERVED_TOP_LEVEL_PATHS.has(normalized) || segment.includes('.');
        if (!isReserved) {
          // Case-insensitive lookup: URLs may arrive lowercased from social crawlers
          const rows = await prisma.$queryRaw<Array<{ id: string; username: string; displayName: string | null; profilePublic: number }>>`
            SELECT id, username, displayName, profilePublic FROM User WHERE username = ${segment} COLLATE NOCASE LIMIT 1
          `;
          const user = rows[0] ? { ...rows[0], profilePublic: Boolean(rows[0].profilePublic) } : null;

          if (user?.profilePublic) {
            const displayName = user.displayName || user.username;
            og = {
              title: `${displayName} on Nala`,
              description: `Check out ${displayName}'s portfolio on Nala - the portfolio intelligence platform`,
              image: `https://nalaai.com/social/${user.id}/share-card`,
              url: `https://nalaai.com/${user.username}`,
              twitterCard: 'summary_large_image',
              twitterSite: '@NalaInvest',
            };
          }
        }
      }
    } catch (error) {
      console.error('[OG] Dynamic OG tag injection failed:', error);
    }

    res.locals.injectedIndexHtml = injectMetaTags(cachedIndexHtml, buildOgMetaTags(og));
    next();
  });

  // SPA fallback: ALL HTML requests (including /) get index.html with no-cache
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    if (typeof res.locals.injectedIndexHtml === 'string' && res.locals.injectedIndexHtml.length > 0) {
      res.type('html').send(res.locals.injectedIndexHtml);
      return;
    }
    res.sendFile(indexPath);
  });
} else {
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
}

// Sentry error handler (must be before generic error handler)
if (config.sentryDsn) {
  Sentry.setupExpressErrorHandler(app);
}

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Express] Unhandled error:', err instanceof Error ? err.message : String(err));
  res.status(500).json({ error: 'Internal server error' });
});

export default app;

