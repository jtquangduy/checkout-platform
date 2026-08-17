import { newId, PaymentId, type Money, type TenantId } from '@platform/contracts';
import type { DomainEvent } from '@platform/kernel';
import { IllegalPaymentTransitionError } from './errors.js';
import { paymentCapturedEvent, paymentFailedEvent } from './payment.events.js';

// Trimmed from DATA-MODEL.md's full status enum (REQUIRES_ACTION | AUTHORIZED
// | PARTIALLY_REFUNDED | CANCELLED are all Phase 2/3 - no 3DS, no partial
// refunds, no saved methods in this pass per DELIVERY-PLAN.md).
export const PAYMENT_STATUSES = ['PENDING', 'CAPTURED', 'FAILED', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const LEGAL: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING: ['CAPTURED', 'FAILED'],   // reconciliation resolves an ambiguous PENDING either way
  CAPTURED: ['REFUNDED'],
  FAILED: [],
  REFUNDED: [],
};

export function isLegalPaymentTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return LEGAL[from].includes(to);
}

export interface CapturedMethod {
  brand: string;
  last4: string;
}

export interface PaymentIntentProps {
  id: PaymentId;
  tenantId: TenantId;
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

export class PaymentIntent {
  private pendingEvents: DomainEvent[] = [];

  private constructor(private props: PaymentIntentProps) {}

  /** Opens a PENDING intent - created BEFORE calling the PSP, so the unique
   *  index on idempotencyKey claims the slot atomically even if the PSP call
   *  itself times out (Part 2's AuthorizeAndCaptureUseCase). */
  static open(input: {
    tenantId: TenantId;
    orderId: string;
    checkoutSessionId: string;
    idempotencyKey: string;
    amount: Money;
    provider: string;
  }): PaymentIntent {
    const now = new Date();
    return new PaymentIntent({
      id: PaymentId.parse(newId('pay')),
      tenantId: input.tenantId,
      orderId: input.orderId,
      checkoutSessionId: input.checkoutSessionId,
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
      amountCaptured: null,
      status: 'PENDING',
      provider: input.provider,
      providerIntentId: null,
      method: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  static reconstitute(props: PaymentIntentProps): PaymentIntent {
    return new PaymentIntent(props);
  }

  get id(): PaymentId { return this.props.id; }
  get tenantId(): TenantId { return this.props.tenantId; }
  get status(): PaymentStatus { return this.props.status; }
  get idempotencyKey(): string { return this.props.idempotencyKey; }
  get snapshot(): Readonly<PaymentIntentProps> { return { ...this.props }; }

  markCaptured(input: { amountCaptured: Money; providerIntentId: string; method: CapturedMethod }): void {
    this.transitionTo('CAPTURED');
    this.props.amountCaptured = input.amountCaptured;
    this.props.providerIntentId = input.providerIntentId;
    this.props.method = input.method;
    this.pendingEvents.push(paymentCapturedEvent(this.props.tenantId, {
      paymentId: this.props.id,
      orderId: this.props.orderId,
      checkoutSessionId: this.props.checkoutSessionId,
      amountCaptured: input.amountCaptured,
      provider: this.props.provider,
      providerIntentId: input.providerIntentId,
      idempotencyKey: this.props.idempotencyKey,
    }));
  }

  markFailed(input: { declineCode: string; message: string }): void {
    this.transitionTo('FAILED');
    this.pendingEvents.push(paymentFailedEvent(this.props.tenantId, {
      paymentId: this.props.id,
      orderId: this.props.orderId,
      checkoutSessionId: this.props.checkoutSessionId,
      declineCode: input.declineCode,
      message: input.message,
      idempotencyKey: this.props.idempotencyKey,
    }));
  }

  private transitionTo(to: PaymentStatus): void {
    const from = this.props.status;
    if (!isLegalPaymentTransition(from, to)) throw new IllegalPaymentTransitionError(from, to);
    this.props.status = to;
    this.props.version += 1;
    this.props.updatedAt = new Date();
  }

  pullEvents(): DomainEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }
}
