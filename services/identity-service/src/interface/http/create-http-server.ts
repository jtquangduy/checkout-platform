import express, { type Express } from 'express';

export function createHttpServer(): Express {
  const app = express();
  app.use(express.json());

  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  return app;
}
