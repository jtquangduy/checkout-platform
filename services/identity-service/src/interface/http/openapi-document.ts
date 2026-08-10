import { OpenApiGeneratorV31 } from '@platform/contracts';
import { registry } from './openapi.js';

export function buildOpenApiDocument(): object {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: 'identity-service API', version: '0.0.1' },
    servers: [{ url: '/' }],
  });
}
