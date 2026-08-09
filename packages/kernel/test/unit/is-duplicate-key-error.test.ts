import { describe, expect, it } from 'vitest';
import { isDuplicateKeyError } from '../../src/inbox/is-duplicate-key-error.js';

describe('isDuplicateKeyError', () => {
  it('recognizes a Mongo duplicate key error by code', () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
  });

  it('rejects other errors', () => {
    expect(isDuplicateKeyError({ code: 26 })).toBe(false);
    expect(isDuplicateKeyError(new Error('boom'))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });
});
