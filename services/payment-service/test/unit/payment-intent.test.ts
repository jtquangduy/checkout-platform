import { describe, expect, it } from 'vitest';
import { newId, TenantId, type Money } from '@platform/contracts';
import { PaymentIntent } from '../../src/domain/payment-intent.js';
import { IllegalPaymentTransitionError } from '../../src/domain/errors.js';

const tenantId = TenantId.parse(newId('ten'));
const amount = { amount: 10_000, currency: 'GBP' } as Money;

function openIntent(): PaymentIntent {
  return PaymentIntent.open({
    tenantId,
    orderId: newId('ord'),
    checkoutSessionId: newId('cko'),
    idempotencyKey: 'cko_test:CAPTURE_PAYMENT',
    amount,
    provider: 'mock',
  });
}

describe('PaymentIntent.open', () => {
  it('starts PENDING with version 0 and no captured amount', () => {
    const intent = openIntent();
    expect(intent.status).toBe('PENDING');
    expect(intent.snapshot.amountCaptured).toBeNull();
    expect(intent.snapshot.version).toBe(0);
  });
});

describe('markCaptured', () => {
  it('transitions PENDING -> CAPTURED and buffers a payment.captured event', () => {
    const intent = openIntent();
    intent.markCaptured({ amountCaptured: amount, providerIntentId: 'pi_mock_1', method: { brand: 'visa', last4: '4242' } });

    expect(intent.status).toBe('CAPTURED');
    expect(intent.snapshot.providerIntentId).toBe('pi_mock_1');

    const events = intent.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('payment.captured');
    expect(intent.pullEvents()).toHaveLength(0); // drained, not just read
  });

  it('refuses to capture an already-CAPTURED intent', () => {
    const intent = openIntent();
    intent.markCaptured({ amountCaptured: amount, providerIntentId: 'pi_1', method: { brand: 'visa', last4: '4242' } });
    expect(() =>
      intent.markCaptured({ amountCaptured: amount, providerIntentId: 'pi_2', method: { brand: 'visa', last4: '4242' } }),
    ).toThrow(IllegalPaymentTransitionError);
  });
});

describe('markFailed', () => {
  it('transitions PENDING -> FAILED and buffers a payment.failed event', () => {
    const intent = openIntent();
    intent.markFailed({ declineCode: 'card_declined', message: 'Your card was declined.' });

    expect(intent.status).toBe('FAILED');
    const events = intent.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('payment.failed');
  });

  it('refuses to fail an already-CAPTURED intent', () => {
    const intent = openIntent();
    intent.markCaptured({ amountCaptured: amount, providerIntentId: 'pi_1', method: { brand: 'visa', last4: '4242' } });
    expect(() => intent.markFailed({ declineCode: 'x', message: 'x' })).toThrow(IllegalPaymentTransitionError);
  });
});
