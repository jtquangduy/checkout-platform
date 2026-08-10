import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MongoClient } from 'mongodb';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { newId, TenantId } from '@platform/contracts';
import { loadIdentityConfig } from '../../src/config.js';
import { compose } from '../../src/composition-root.js';

const MONGO_URI =
  process.env.MONGO_TEST_URI ??
  'mongodb://admin:devpassword@localhost:27017/?replicaSet=rs0&directConnection=true&authSource=admin';
const MONGO_DB_NAME = 'identity_test';

let ctx: Awaited<ReturnType<typeof compose>>;
const tenantId = TenantId.parse(newId('ten'));

beforeAll(async () => {
  // Clean slate: a previous run leaves this fixed test email registered,
  // which would collide with the unique index on email.
  const cleanupClient = new MongoClient(MONGO_URI);
  await cleanupClient.connect();
  await cleanupClient.db(MONGO_DB_NAME).dropDatabase();
  await cleanupClient.close();

  const cfg = loadIdentityConfig({
    ...process.env,
    MONGO_URI,
    MONGO_DB_NAME,
    NODE_ENV: 'development',
    JWT_PRIVATE_KEY_PATH: '../../infra/keys/jwt-private.pem',
    JWT_PUBLIC_KEY_PATH: '../../infra/keys/jwt-public.pem',
  });
  ctx = await compose(cfg);

  await ctx.registerUser.execute({
    tenantId,
    email: 'test-login@example.com',
    name: 'Test User',
    password: 'correct horse battery staple',
    roles: ['ART_DIRECTOR'],
  });
});

afterAll(async () => {
  await ctx.shutdown();
});

describe('POST /login + GET /.well-known/jwks.json', () => {
  it('issues an access token that verifies against the published JWKS', async () => {
    const loginRes = await request(ctx.app)
      .post('/login')
      .send({ email: 'test-login@example.com', password: 'correct horse battery staple' });

    expect(loginRes.status).toBe(200);
    const { accessToken } = loginRes.body;
    expect(typeof accessToken).toBe('string');

    const jwksRes = await request(ctx.app).get('/.well-known/jwks.json');
    expect(jwksRes.status).toBe(200);

    const jwks = createLocalJWKSet(jwksRes.body);
    const { payload } = await jwtVerify(accessToken, jwks);

    expect(payload.tid).toBe(tenantId);
    expect(payload.roles).toEqual(['ART_DIRECTOR']);
  });

  it('rejects a wrong password without revealing which part was wrong', async () => {
    const res = await request(ctx.app)
      .post('/login')
      .send({ email: 'test-login@example.com', password: 'not the password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });

  it('rejects an unknown email with the SAME error as a wrong password', async () => {
    const res = await request(ctx.app)
      .post('/login')
      .send({ email: 'nobody@example.com', password: 'anything' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });
});
