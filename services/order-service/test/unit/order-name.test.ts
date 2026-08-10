import { describe, expect, it } from 'vitest';
import { normalizeOrderName } from '../../src/domain/order/order-name.vo.js';

describe('normalizeOrderName', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeOrderName('Café León').normalized).toBe('cafe leon');
  });

  it('tokenizes on punctuation as well as spaces', () => {
    expect(normalizeOrderName('Nike SS26 Apparel — Batch 04').tokens).toEqual([
      'nike', 'ss26', 'apparel', 'batch', '04',
    ]);
  });
});
