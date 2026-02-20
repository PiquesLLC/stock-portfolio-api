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

// Initialize Sentry before Express app (must be first)
if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    tracesSampleRate: config.nodeEnv === 'production' ? 0.1 : 1.0,
    beforeSend(event) {
      // Strip sensitive headers
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['cookie'];
      }
      return event;
    },
  });
}

const app = express();

// Trust reverse proxy (Railway, Heroku, etc.) for correct IP detection in rate limiting
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Security headers (CSP, X-Frame-Options, etc.)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.plaid.com"],
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
const jsonParser = express.json({
  // Capture raw body for webhook signature verification (Plaid)
  verify: (req: any, _res, buf) => {
    req.rawBody = buf.toString('utf-8');
  },
});
app.use((req, res, next) => {
  // Stripe webhook uses route-level express.raw() for signature verification.
  if (req.path === '/billing/webhook' || req.path === '/creator/webhooks/stripe') {
    next();
    return;
  }
  jsonParser(req, res, next);
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
  app.use(express.static(clientDir));
  // SPA fallback: serve index.html for any non-API route
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
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
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
