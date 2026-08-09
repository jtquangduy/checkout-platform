import { describe, expect, it } from 'vitest';
import { newId } from '../src/id.js';
import { UserId } from '../src/value-objects.js';

describe('newId', () => {
  it('produces an id that satisfies its own branded schema', () => {
    expect(() => UserId.parse(newId('usr'))).not.toThrow();
  });

  it('produces unique ids', () => {
    expect(newId('usr')).not.toBe(newId('usr'));
  });
});
