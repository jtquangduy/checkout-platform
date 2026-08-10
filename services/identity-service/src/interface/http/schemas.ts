import { z } from '@platform/contracts';

// The same schema validates the request AND documents it — see
// src/interface/http/openapi.ts. Two separate objects would inevitably
// drift, which is the exact failure mode contract-first generation exists
// to remove.
export const LoginRequestSchema = z.object({
  email: z.string().email().openapi({ example: 'sofia@nikestudio.example' }),
  password: z.string().min(1),
});

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
});

export const ErrorResponseSchema = z.object({
  error: z.string().openapi({ example: 'INVALID_CREDENTIALS' }),
});
