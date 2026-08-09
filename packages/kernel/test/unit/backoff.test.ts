import { describe, expect, it } from 'vitest';
import { backoffMs } from '../../src/outbox/backoff.js';

describe('backoffMs', () => {
  it('grows with attempt count', () => {
    expect(backoffMs(4)).toBeGreaterThan(backoffMs(0));
  });

  it('caps so it never grows unbounded', () => {
    expect(backoffMs(20)).toBeLessThan(80_000);
  });

  it('adds jitter so repeated calls are not identical', () => {
    const values = new Set(Array.from({ length: 5 }, () => backoffMs(2)));
    expect(values.size).toBeGreaterThan(1);
  });
});
