import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import swaggerUi from 'swagger-ui-express';

export type ServiceEnv = 'development' | 'staging' | 'production';

export interface MountSwaggerOptions {
  service: string;
  env: ServiceEnv;
  /** Absolute path to the build-time-generated openapi.generated.json.
   *  Each service resolves this itself (relative to its own dist/src
   *  location), since kernel has no fixed relationship to any service's
   *  directory layout. */
  specPath: string;
}

/** Serves the spec at /openapi.json in every environment, and an
 *  interactive Swagger UI at /docs everywhere EXCEPT production — a
 *  "Try it out" button next to a real payments endpoint is a footgun
 *  waiting to charge a real card during a demo. */
export function mountSwagger(app: Express, opts: MountSwaggerOptions): void {
  const spec: object = JSON.parse(readFileSync(opts.specPath, 'utf-8'));

  app.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });

  if (opts.env !== 'production') {
    app.use(
      '/docs',
      swaggerUi.serve,
      swaggerUi.setup(spec, {
        swaggerOptions: {
          persistAuthorization: true,
          tryItOutEnabled: true,
          displayRequestDuration: true,
        },
        customSiteTitle: `${opts.service} API`,
      }),
    );
  }
}
