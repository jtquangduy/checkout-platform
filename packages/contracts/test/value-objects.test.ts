import { describe, it, expect } from 'vitest';
import { Money, addMoney, applyRate, CurrencyMismatchError, OrderId } from '../src/value-objects.js';

describe('Money', () => {
  it('adds two amounts of the same currency', () => {
    const a = Money.parse({ amount: 1000, currency: 'USD' });
    const b = Money.parse({ amount: 250, currency: 'USD' });
    expect(addMoney(a, b)).toEqual({ amount: 1250, currency: 'USD' });
  });

  it('rejects addition across currencies', () => {
    const a = Money.parse({ amount: 1000, currency: 'USD' });
    const b = Money.parse({ amount: 250, currency: 'GBP' });
    expect(() => addMoney(a, b)).toThrow(CurrencyMismatchError);
  });

  it('rejects a non-integer amount', () => {
    expect(() => Money.parse({ amount: 19.99, currency: 'USD' })).toThrow();
  });

  it('applies a rate', () => {
    const m = Money.parse({ amount: 250, currency: 'USD' });
    expect(applyRate(m, 0.2)).toEqual({ amount: 50, currency: 'USD' });
  });
});

describe('OrderId', () => {
  it('accepts a valid prefixed ULID', () => {
    expect(() => OrderId.parse('ord_01JBQ7X8K3ZP4Y6M2N9V5TWDFH')).not.toThrow();
  });

  it('rejects the wrong prefix', () => {
    expect(() => OrderId.parse('ten_01JBQ7X8K3ZP4Y6M2N9V5TWDFH')).toThrow();
  });
});
