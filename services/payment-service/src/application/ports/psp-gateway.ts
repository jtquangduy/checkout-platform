import type { Money } from '@platform/contracts';

export interface PspChargeRequest {
  idempotencyKey: string;
  amount: Money;
  paymentMethodToken: string;
}

export type PspChargeOutcome =
  | { status: 'SUCCEEDED'; providerIntentId: string; providerTransactionId: string; brand: string; last4: string }
  | { status: 'DECLINED'; declineCode: string; message: string };

/** The only boundary that talks to a real payment processor (ARCHITECTURE.md:
 *  payment-service is the only service that ever sees a PSP token). Swapping
 *  mock for Stripe/Adyen later is a new class behind this interface; nothing
 *  above it changes.
 *
 *  charge() throws PspTimeoutError for a genuinely ambiguous outcome -
 *  callers must reconcile via findByIdempotencyKey(), never assume failure
 *  and retry blind (CHECKOUT-SAGA.md §4.3).
 *
 *  NOTE for whenever a real adapter is built: Money.amount is always minor
 *  units assuming a 2-decimal currency. Some real PSPs treat some currencies
 *  (e.g. VND) as zero-decimal - a real adapter needs a per-provider currency
 *  exponent table at this boundary, or amounts will be off by 100x. Not
 *  relevant to the mock, but easy to forget later since nothing else in this
 *  codebase surfaces it. */
export interface PspGateway {
  charge(request: PspChargeRequest): Promise<PspChargeOutcome>;
  findByIdempotencyKey(idempotencyKey: string): Promise<PspChargeOutcome | null>;
  refund(providerIntentId: string, amount: Money): Promise<{ providerTransactionId: string }>;
}
