import { PaymentId, TenantId } from '@platform/contracts';
import { PaymentIntent } from '../../domain/payment-intent.js';
import type { PaymentIntentDocument } from './payment-intent.document.js';

export function toPaymentIntentDocument(intent: PaymentIntent): PaymentIntentDocument {
  const s = intent.snapshot;
  return {
    _id: s.id,
    tenantId: s.tenantId,
    orderId: s.orderId,
    checkoutSessionId: s.checkoutSessionId,
    idempotencyKey: s.idempotencyKey,
    amount: s.amount,
    amountCaptured: s.amountCaptured,
    status: s.status,
    provider: s.provider,
    providerIntentId: s.providerIntentId,
    method: s.method,
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function toDomainPaymentIntent(doc: PaymentIntentDocument): PaymentIntent {
  return PaymentIntent.reconstitute({
    id: PaymentId.parse(doc._id),
    tenantId: TenantId.parse(doc.tenantId),
    orderId: doc.orderId,
    checkoutSessionId: doc.checkoutSessionId,
    idempotencyKey: doc.idempotencyKey,
    amount: doc.amount,
    amountCaptured: doc.amountCaptured,
    status: doc.status,
    provider: doc.provider,
    providerIntentId: doc.providerIntentId,
    method: doc.method,
    version: doc.version,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}
