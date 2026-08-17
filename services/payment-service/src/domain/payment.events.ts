import { newId, type Money, type PaymentId, type TenantId } from '@platform/contracts';
import type { DomainEvent } from '@platform/kernel';

export interface PaymentCapturedPayload {
  paymentId: PaymentId;
  orderId: string;
  checkoutSessionId: string;
  amountCaptured: Money;
  provider: string;
  providerIntentId: string;
  idempotencyKey: string;
}

export function paymentCapturedEvent(tenantId: TenantId, payload: PaymentCapturedPayload): DomainEvent<PaymentCapturedPayload> {
  return {
    messageId: newId('evt'),
    aggregateType: 'PaymentIntent',
    aggregateId: payload.paymentId,
    type: 'payment.captured',
    version: 1,
    tenantId,
    payload,
    occurredAt: new Date(),
  };
}

export interface PaymentFailedPayload {
  paymentId: PaymentId;
  orderId: string;
  checkoutSessionId: string;
  declineCode: string;
  message: string;
  idempotencyKey: string;
}

export function paymentFailedEvent(tenantId: TenantId, payload: PaymentFailedPayload): DomainEvent<PaymentFailedPayload> {
  return {
    messageId: newId('evt'),
    aggregateType: 'PaymentIntent',
    aggregateId: payload.paymentId,
    type: 'payment.failed',
    version: 1,
    tenantId,
    payload,
    occurredAt: new Date(),
  };
}
