import { describe, expect, it } from 'vitest';
import { priceOrder } from '../../src/domain/pricing/pricing-engine.js';
import { SkuNotFoundError } from '../../src/domain/errors.js';
import type { PriceBook } from '../../src/domain/pricing/price-book.js';

const priceBook: PriceBook = {
  id: 'pbk_test',
  tenantId: 'ten_test',
  name: 'Test Book',
  version: 3,
  currency: 'GBP',
  status: 'ACTIVE',
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
  prices: [
    { skuCode: 'GHOST_MANNEQUIN_V2', description: 'Ghost mannequin (v2)', unitPrice: { amount: 320, currency: 'GBP' } as never },
  ],
  orderVolumeTiers: [
    { minUnits: 200, discountBps: 250 },
    { minUnits: 400, discountBps: 500 },
    { minUnits: 1000, discountBps: 800 },
  ],
  taxProfile: { code: 'GB-VAT-STD', rate: 0.2, reverseCharge: false },
};

describe('priceOrder', () => {
  it('prices a single line with no volume tier below the lowest threshold', () => {
    const result = priceOrder(priceBook, [{ skuCode: 'GHOST_MANNEQUIN_V2', quantity: 100 }]);

    expect(result.lines).toHaveLength(1);
    expect(result.subtotal).toEqual({ amount: 32_000, currency: 'GBP' });
    expect(result.tax).toEqual({ amount: 6_400, currency: 'GBP' });
    expect(result.total).toEqual({ amount: 38_400, currency: 'GBP' });
  });

  it('applies the 500bps tier to the whole subtotal at 400 units, as a negative line', () => {
    const result = priceOrder(priceBook, [{ skuCode: 'GHOST_MANNEQUIN_V2', quantity: 400 }]);

    expect(result.lines).toHaveLength(2);
    const discountLine = result.lines[1];
    expect(discountLine?.skuCode).toBe('VOLUME_DISCOUNT');
    expect(discountLine?.lineTotal).toEqual({ amount: -6_400, currency: 'GBP' }); // 5% of 128,000
    expect(discountLine?.taxAmount).toEqual({ amount: 0, currency: 'GBP' }); // discount itself isn't taxed

    expect(result.subtotal).toEqual({ amount: 128_000, currency: 'GBP' });
    expect(result.tax).toEqual({ amount: 25_600, currency: 'GBP' }); // only the SKU line is taxed
    expect(result.total).toEqual({ amount: 147_200, currency: 'GBP' }); // 128,000 - 6,400 + 25,600
  });

  it('is deterministic: the same inputs always produce the same integrityHash', () => {
    const a = priceOrder(priceBook, [{ skuCode: 'GHOST_MANNEQUIN_V2', quantity: 400 }]);
    const b = priceOrder(priceBook, [{ skuCode: 'GHOST_MANNEQUIN_V2', quantity: 400 }]);
    expect(a.integrityHash).toBe(b.integrityHash);
    expect(a.integrityHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('a different priceBookVersion changes the hash even if the money is identical', () => {
    const a = priceOrder(priceBook, [{ skuCode: 'GHOST_MANNEQUIN_V2', quantity: 100 }]);
    const b = priceOrder({ ...priceBook, version: 4 }, [{ skuCode: 'GHOST_MANNEQUIN_V2', quantity: 100 }]);
    expect(a.integrityHash).not.toBe(b.integrityHash);
  });

  it('throws SkuNotFoundError for a SKU not in the active price book', () => {
    expect(() => priceOrder(priceBook, [{ skuCode: 'NOT_A_REAL_SKU', quantity: 1 }])).toThrow(SkuNotFoundError);
  });
});
