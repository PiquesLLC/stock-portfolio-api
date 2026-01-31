import express from 'express';
import cors from 'cors';
import routes from './routes';

const app = express();

app.use(cors());
app.use(express.json());

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

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
