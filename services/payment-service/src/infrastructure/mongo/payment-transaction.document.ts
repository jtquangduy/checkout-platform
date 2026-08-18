import type { Money } from '@platform/contracts';

export type PaymentTransactionOutcome = 'SUCCEEDED' | 'FAILED' | 'PENDING';

// Only CAPTURE in this pass - REFUND arrives with the saga compensation step.
export interface PaymentTransactionDocument {
  _id: string;
  tenantId: string;
  paymentIntentId: string;
  sequence: number;
  type: 'CAPTURE';
  outcome: PaymentTransactionOutcome;
  amount: Money;
  provider: string;
  providerTransactionId: string | null;
  declineCode: string | null;
  message: string | null;
  occurredAt: Date;
}
