import type { Money } from '@platform/contracts';
import { PspTimeoutError } from '../../domain/errors.js';
import type { PspChargeOutcome, PspChargeRequest, PspGateway } from '../../application/ports/psp-gateway.js';

/** Deterministic by payment method token, mirroring the real PSP mock's
 *  test-card table (API.md §3.4) - so tests never rely on randomness.
 *
 *  'tok_visa_timeout' simulates CHECKOUT-SAGA.md §4.3: the charge actually
 *  succeeds on the PSP's side on the FIRST attempt, but the caller never
 *  sees the response - only a later findByIdempotencyKey() lookup reveals
 *  the true outcome, same as the real PSP would answer a GET after a lost
 *  response.
 *
 *  'tok_visa_timeout_unresolvable' simulates the rarer case where even the
 *  reconciliation lookup is unavailable - it never records anything. */
export class MockPspGateway implements PspGateway {
  private readonly byIdempotencyKey = new Map<string, PspChargeOutcome>();
  private readonly timedOutOnce = new Set<string>();
  private counter = 0;

  async charge(request: PspChargeRequest): Promise<PspChargeOutcome> {
    const existing = this.byIdempotencyKey.get(request.idempotencyKey);
    if (existing) return existing; // the PSP's OWN idempotency - a byte-identical retry gets the same answer

    if (request.paymentMethodToken === 'tok_visa_timeout_unresolvable') {
      throw new PspTimeoutError(request.idempotencyKey);
    }

    if (request.paymentMethodToken === 'tok_visa_timeout' && !this.timedOutOnce.has(request.idempotencyKey)) {
      this.timedOutOnce.add(request.idempotencyKey);
      this.byIdempotencyKey.set(request.idempotencyKey, {
        status: 'SUCCEEDED',
        providerIntentId: this.fakeProviderId('pi'),
        providerTransactionId: this.fakeProviderId('ch'),
        brand: 'visa',
        last4: '4242',
      });
      throw new PspTimeoutError(request.idempotencyKey);
    }

    const outcome: PspChargeOutcome =
      request.paymentMethodToken === 'tok_visa_declined'
        ? { status: 'DECLINED', declineCode: 'card_declined', message: 'Your card was declined.' }
        : {
            status: 'SUCCEEDED',
            providerIntentId: this.fakeProviderId('pi'),
            providerTransactionId: this.fakeProviderId('ch'),
            brand: 'visa',
            last4: '4242',
          };

    this.byIdempotencyKey.set(request.idempotencyKey, outcome);
    return outcome;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PspChargeOutcome | null> {
    return this.byIdempotencyKey.get(idempotencyKey) ?? null;
  }

  async refund(_providerIntentId: string, _amount: Money): Promise<{ providerTransactionId: string }> {
    return { providerTransactionId: this.fakeProviderId('re') };
  }

  private fakeProviderId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_mock_${this.counter}`;
  }
}
