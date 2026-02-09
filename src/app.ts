import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import routes from './routes';
import { config } from './config';
import { apiLimiter } from './middleware/rateLimiter';

const app = express();

// Security headers (CSP, X-Frame-Options, etc.)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", ...config.allowedOrigins],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      workerSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", "blob:", "https:"],
      frameSrc: ["'none'"],
    },
  },
}));

// CORS configuration - locked down to specific origins
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman) in dev only
    if (!origin && config.nodeEnv === 'development') {
      return callback(null, true);
    }
    if (origin && config.allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // In development, allow LAN origins (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    if (config.nodeEnv === 'development' && origin) {
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
app.use(express.json());

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

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
