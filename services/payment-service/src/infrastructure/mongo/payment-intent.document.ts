import type { TenantScoped } from '@platform/kernel';
import type { Money } from '@platform/contracts';
import type { CapturedMethod, PaymentStatus } from '../../domain/payment-intent.js';

export interface PaymentIntentDocument extends TenantScoped {
  _id: string;
  tenantId: string;
  orderId: string;
  checkoutSessionId: string;
  idempotencyKey: string;
  amount: Money;
  amountCaptured: Money | null;
  status: PaymentStatus;
  provider: string;
  providerIntentId: string | null;
  method: CapturedMethod | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
