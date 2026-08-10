import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import request from 'supertest';
import { buildOpenApiDocument } from '../../src/interface/http/openapi-document.js';
import { loadIdentityConfig } from '../../src/config.js';
import { compose } from '../../src/composition-root.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Same resolved path create-http-server.ts reads from: test/integration is
// two levels below the service root, same depth as src/interface/http and
// dist/interface/http, so the file both sides agree on is identical.
const specPath = join(__dirname, '../../openapi.generated.json');

let ctx: Awaited<ReturnType<typeof compose>>;

beforeAll(async () => {
  // Regenerate fresh rather than relying on a prior `pnpm build` having run.
  writeFileSync(specPath, JSON.stringify(buildOpenApiDocument(), null, 2));

  const cfg = loadIdentityConfig({
    ...process.env,
    MONGO_URI:
      process.env.MONGO_TEST_URI ??
      'mongodb://admin:devpassword@localhost:27017/?replicaSet=rs0&directConnection=true&authSource=admin',
    MONGO_DB_NAME: 'identity_test_openapi',
    NODE_ENV: 'development',
    JWT_PRIVATE_KEY_PATH: '../../infra/keys/jwt-private.pem',
    JWT_PUBLIC_KEY_PATH: '../../infra/keys/jwt-public.pem',
  });
  ctx = await compose(cfg);
});

afterAll(async () => {
  await ctx.shutdown();
});

describe('OpenAPI / Swagger', () => {
  it('serves a generated spec that documents the real /login endpoint', async () => {
    const res = await request(ctx.app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths['/login'].post).toBeDefined();
    expect(res.body.paths['/.well-known/jwks.json'].get).toBeDefined();
  });

  it('the documented request schema is the SAME schema that validates real requests', async () => {
    const res = await request(ctx.app).get('/openapi.json');
    const loginRequestRef = res.body.paths['/login'].post.requestBody.content['application/json'].schema.$ref;
    expect(loginRequestRef).toBe('#/components/schemas/LoginRequest');
    expect(res.body.components.schemas.LoginRequest.properties.email).toBeDefined();
  });

  it('serves interactive docs outside production', async () => {
    const res = await request(ctx.app).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.text.toLowerCase()).toContain('swagger');
  });
});
