export class IllegalPaymentTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot transition payment from ${from} to ${to}`);
    this.name = 'IllegalPaymentTransitionError';
  }
}

/** Thrown by a PspGateway when the outcome of a charge is genuinely unknown
 *  (e.g. a socket timeout after the PSP may have already moved money).
 *  CHECKOUT-SAGA.md §4.3: never assume failure and retry blind - reconcile
 *  by querying the PSP for this exact idempotency key instead. */
export class PspTimeoutError extends Error {
  constructor(idempotencyKey: string) {
    super(`PSP call timed out for idempotency key ${idempotencyKey} — outcome unknown`);
    this.name = 'PspTimeoutError';
  }
}
