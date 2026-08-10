import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mountSwagger } from '../../src/http/swagger.js';

const FAKE_SPEC = {
  openapi: '3.1.0',
  info: { title: 'fake-service API', version: '0.0.1' },
  paths: { '/widgets': { get: { summary: 'List widgets', responses: { 200: { description: 'OK' } } } } },
};

let tmpDir: string;
let specPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mount-swagger-test-'));
  specPath = join(tmpDir, 'openapi.generated.json');
  writeFileSync(specPath, JSON.stringify(FAKE_SPEC));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function appWith(env: 'development' | 'staging' | 'production'): Express {
  const app = express();
  mountSwagger(app, { service: 'fake-service', env, specPath });
  return app;
}

describe('mountSwagger', () => {
  it('serves the exact spec at /openapi.json regardless of environment', async () => {
    const res = await request(appWith('production')).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(FAKE_SPEC);
  });

  it('serves interactive docs in development', async () => {
    const res = await request(appWith('development')).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.text.toLowerCase()).toContain('swagger');
  });

  it('does NOT serve interactive docs in production', async () => {
    const res = await request(appWith('production')).get('/docs/');
    expect(res.status).toBe(404);
  });
});
