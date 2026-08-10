import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express, { type Express, type Router, type Request, type Response, type NextFunction } from 'express';
import { mountSwagger, type ServiceEnv } from '@platform/kernel';

// Same reasoning as generate-openapi.ts: resolve relative to this file's own
// compiled location, not process.cwd(), which varies by how main.ts is launched.
const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAPI_SPEC_PATH = join(__dirname, '../../../openapi.generated.json');

export interface CreateHttpServerOptions {
  routers: Router[];
  env: ServiceEnv;
}

export function createHttpServer({ routers, env }: CreateHttpServerOptions): Express {
  const app = express();
  app.use(express.json());

  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  for (const router of routers) app.use(router);

  mountSwagger(app, { service: 'identity-service', env, specPath: OPENAPI_SPEC_PATH });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  return app;
}
