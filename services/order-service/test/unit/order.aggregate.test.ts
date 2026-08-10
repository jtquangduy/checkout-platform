import { describe, expect, it } from 'vitest';
import { Order } from '../../src/domain/order/order.aggregate.js';
import { EmptyOrderError, IllegalTransitionError, OrderNotEditableError } from '../../src/domain/errors.js';
import { Money, newId, TenantId } from '@platform/contracts';

// A real, valid id — hand-typing a fake ULID risks getting its length or
// alphabet wrong (Crockford Base32 excludes I, L, O, U), and Money/branded
// ids validate on construction, so a bad literal fails loudly here anyway.
const tenantId = TenantId.parse(newId('ten'));

function fakeItem(overrides: Partial<Parameters<Order['addItem']>[0]> = {}) {
  return {
    id: 'item_1',
    assetId: 'ast_1',
    filename: 'front.tif',
    skuCode: 'RETOUCH-STD',
    quantity: 1,
    unitPrice: Money.parse({ amount: 1000, currency: 'USD' }),
    lineTotal: Money.parse({ amount: 1000, currency: 'USD' }),
    ...overrides,
  };
}

describe('Order.create', () => {
  it('starts in DRAFT with no items and version 0', () => {
    const order = Order.create({ tenantId, name: 'Nike SS26 Apparel — Batch 04' });
    expect(order.status).toBe('DRAFT');
    expect(order.items).toHaveLength(0);
    expect(order.version).toBe(0);
  });

  it('normalizes and tokenizes the name, splitting on the em-dash', () => {
    const order = Order.create({ tenantId, name: 'Nike SS26 Apparel — Batch 04' });
    expect(order.snapshot.nameTokens).toEqual(['nike', 'ss26', 'apparel', 'batch', '04']);
  });
});

describe('item editing', () => {
  it('allows adding and removing items while DRAFT', () => {
    const order = Order.create({ tenantId, name: 'Test' });
    order.addItem(fakeItem());
    expect(order.items).toHaveLength(1);
    order.removeItem('item_1');
    expect(order.items).toHaveLength(0);
  });

  it('forbids editing items once past DRAFT', () => {
    const order = Order.create({ tenantId, name: 'Test' });
    order.addItem(fakeItem());
    order.moveToPricing();
    expect(() => order.addItem(fakeItem({ id: 'item_2' }))).toThrow(OrderNotEditableError);
  });
});

describe('state transitions', () => {
  it('refuses to price an empty order', () => {
    const order = Order.create({ tenantId, name: 'Test' });
    expect(() => order.moveToPricing()).toThrow(EmptyOrderError);
  });

  it('moves DRAFT -> PRICING -> READY_FOR_CHECKOUT legally', () => {
    const order = Order.create({ tenantId, name: 'Test' });
    order.addItem(fakeItem());
    order.moveToPricing();
    expect(order.status).toBe('PRICING');
    order.markReadyForCheckout();
    expect(order.status).toBe('READY_FOR_CHECKOUT');
    expect(order.version).toBe(2); // one increment per transition
  });

  it('refuses an illegal transition, e.g. DRAFT straight to READY_FOR_CHECKOUT', () => {
    const order = Order.create({ tenantId, name: 'Test' });
    order.addItem(fakeItem());
    expect(() => order.markReadyForCheckout()).toThrow(IllegalTransitionError);
  });

  it('buffers a domain event per transition and drains it exactly once', () => {
    const order = Order.create({ tenantId, name: 'Test' });
    order.addItem(fakeItem());
    order.moveToPricing();

    const events = order.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('order.status_changed');
    expect(order.pullEvents()).toHaveLength(0); // drained, not just read
  });
});
