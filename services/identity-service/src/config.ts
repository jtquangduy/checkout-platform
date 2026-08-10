import { z } from 'zod';
import { loadConfig } from '@platform/kernel';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().default(3001),
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  MONGO_URI: z.string().min(1),
  MONGO_DB_NAME: z.string().default('identity'),
  JWT_PRIVATE_KEY_PATH: z.string().min(1),
  JWT_PUBLIC_KEY_PATH: z.string().min(1),
  JWT_KID: z.string().default('identity-dev-1'),
  JWT_ISSUER: z.string().default('https://auth.local.test'),
  JWT_AUDIENCE: z.string().default('customer-portal'),
  JWT_ACCESS_TOKEN_TTL: z.string().default('15m'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return loadConfig(ConfigSchema, env);
}
