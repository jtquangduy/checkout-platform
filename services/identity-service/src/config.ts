import { z } from 'zod';
import { loadConfig } from '@platform/kernel';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().default(3001),
  MONGO_URI: z.string().min(1),
  MONGO_DB_NAME: z.string().default('identity'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return loadConfig(ConfigSchema, env);
}
