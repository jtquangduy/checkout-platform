import { createServiceRegistry, z } from '@platform/contracts';
import { LoginRequestSchema, LoginResponseSchema, ErrorResponseSchema } from './schemas.js';

export const registry = createServiceRegistry();

const LoginRequest = registry.register('LoginRequest', LoginRequestSchema);
const LoginResponse = registry.register('LoginResponse', LoginResponseSchema);
const ErrorResponse = registry.register('ErrorResponse', ErrorResponseSchema);

registry.registerPath({
  method: 'post',
  path: '/login',
  tags: ['Auth'],
  summary: 'Exchange email + password for a short-lived access token',
  request: {
    body: { content: { 'application/json': { schema: LoginRequest } } },
  },
  responses: {
    200: { description: 'Authenticated', content: { 'application/json': { schema: LoginResponse } } },
    400: { description: 'Malformed request body', content: { 'application/json': { schema: ErrorResponse } } },
    401: {
      description: 'Invalid email or password — the same error either way, so login cannot be used to enumerate registered emails',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const Jwk = registry.register(
  'Jwk',
  z
    .object({
      kty: z.string(),
      n: z.string(),
      e: z.string(),
      kid: z.string(),
      alg: z.string(),
      use: z.string(),
    })
    .passthrough(),
);

registry.registerPath({
  method: 'get',
  path: '/.well-known/jwks.json',
  tags: ['Auth'],
  summary: 'Public keys for verifying access tokens issued by this service',
  description: 'Cache this by kid. A gateway or another service should never call /login-adjacent endpoints to verify a token — that is the entire point of asymmetric signing.',
  responses: {
    200: {
      description: 'JSON Web Key Set',
      content: { 'application/json': { schema: z.object({ keys: z.array(Jwk) }) } },
    },
  },
});
