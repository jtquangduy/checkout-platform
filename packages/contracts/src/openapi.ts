import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Patches `.openapi({...})` onto every zod schema. Must run before any
// service attaches metadata to a schema, which is why this module — not
// each service — owns the call, and every service imports `z` from here
// rather than from 'zod' directly when building request/response schemas.
extendZodWithOpenApi(z);

export { z, OpenAPIRegistry, OpenApiGeneratorV31 };

/** One registry per service, pre-loaded with the components every service
 *  needs so they don't each redeclare the same security scheme slightly
 *  differently. */
export function createServiceRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Short-lived RS256 access token, verified against the issuing service\'s published JWKS.',
  });

  return registry;
}
