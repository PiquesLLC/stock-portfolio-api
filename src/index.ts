import app from './app';
import { config } from './config';

const server = app.listen(config.port, () => {
  console.log(`Stock Portfolio API running on http://localhost:${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
