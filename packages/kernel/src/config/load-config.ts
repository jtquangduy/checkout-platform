import { z } from 'zod';

export class ConfigValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(`Invalid configuration:\n${issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

/** Pure validation — throws, never exits. Kept separate from loadConfig so it's unit-testable. */
export function parseConfig<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) throw new ConfigValidationError(result.error.issues);
  return result.data;
}

/** What a service actually calls at boot. Invalid config prints the reason and exits(1)
 *  rather than the service starting half-configured and failing mysteriously later. */
export function loadConfig<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv = process.env): z.infer<T> {
  try {
    return parseConfig(schema, env);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
