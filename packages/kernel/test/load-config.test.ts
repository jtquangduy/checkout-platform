import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseConfig, ConfigValidationError } from '../src/config/load-config.js';

const Schema = z.object({
  PORT: z.coerce.number().int(),
  MONGO_URI: z.string().url(),
});

describe('parseConfig', () => {
  it('returns a typed config object from valid env', () => {
    const cfg = parseConfig(Schema, { PORT: '3000', MONGO_URI: 'mongodb://localhost:27017' });
    expect(cfg).toEqual({ PORT: 3000, MONGO_URI: 'mongodb://localhost:27017' });
  });

  it('throws ConfigValidationError on missing/invalid env', () => {
    expect(() => parseConfig(Schema, { PORT: 'not-a-number' })).toThrow(ConfigValidationError);
  });
});
