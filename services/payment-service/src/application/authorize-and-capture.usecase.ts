import type { MongoClient } from 'mongodb';
import { isDuplicateKeyError, withOutbox, type UnitOfWork } from '@platform/kernel';
import { newId, type Money, type TenantId } from '@platform/contracts';
import { PaymentIntent } from '../domain/payment-intent.js';
import { PspTimeoutError } from '../domain/errors.js';
import type { PspChargeOutcome, PspGateway } from './ports/psp-gateway.js';
import type { PaymentIntentDocument } from '../infrastructure/mongo/payment-intent.document.js';
import type { PaymentTransactionDocument } from '../infrastructure/mongo/payment-transaction.document.js';
import { toDomainPaymentIntent, toPaymentIntentDocument } from '../infrastructure/mongo/payment.mapper.js';

export interface AuthorizeAndCaptureCommand {
  tenantId: TenantId;
  orderId: string;
  checkoutSessionId: string;
  idempotencyKey: string;
  amount: Money;
  paymentMethodToken: string;
}

export type AuthorizeAndCaptureResult =
  | { outcome: 'CAPTURED'; paymentId: string; amountCaptured: Money }
  | { outcome: 'ALREADY_CAPTURED'; paymentId: string; amountCaptured: Money }
  | { outcome: 'DECLINED'; declineCode: string; message: string }
  | { outcome: 'PENDING_RECONCILIATION'; paymentId: string };

export class AuthorizeAndCaptureUseCase {
  constructor(
    private readonly mongo: MongoClient,
    private readonly dbName: string,
    private readonly psp: PspGateway,
  ) {}

  async execute(cmd: AuthorizeAndCaptureCommand): Promise<AuthorizeAndCaptureResult> {
    const intent = await this.openOrFindExisting(cmd);

    if (intent.status === 'CAPTURED') {
      // CAPTURED always has amountCaptured set - the aggregate's own invariant.
      return { outcome: 'ALREADY_CAPTURED', paymentId: intent.id, amountCaptured: intent.snapshot.amountCaptured! };
    }
    if (intent.status !== 'PENDING') {
      return { outcome: 'DECLINED', declineCode: 'previously_failed', message: 'This payment attempt already failed.' };
    }

    let outcome: PspChargeOutcome;
    try {
      outcome = await this.psp.charge({
        idempotencyKey: cmd.idempotencyKey,
        amount: cmd.amount,
        paymentMethodToken: cmd.paymentMethodToken,
      });
    } catch (err) {
      if (!(err instanceof PspTimeoutError)) throw err;
      return this.reconcileAfterTimeout(intent);
    }

    return this.finalize(intent, outcome);
  }

  /** Claims the idempotency key FIRST, atomically, before ever calling the
   *  PSP - so a retry (same key) always finds the SAME intent rather than
   *  racing to create two. */
  private async openOrFindExisting(cmd: AuthorizeAndCaptureCommand): Promise<PaymentIntent> {
    const intent = PaymentIntent.open({
      tenantId: cmd.tenantId,
      orderId: cmd.orderId,
      checkoutSessionId: cmd.checkoutSessionId,
      idempotencyKey: cmd.idempotencyKey,
      amount: cmd.amount,
      provider: 'mock',
    });

    try {
      await withOutbox(this.mongo, this.dbName, async (uow) => {
        await uow.collection<PaymentIntentDocument>('payment_intents').insertOne(toPaymentIntentDocument(intent));
        return { result: undefined, events: [] };
      });
      return intent;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const db = this.mongo.db(this.dbName);
      const existing = await db
        .collection<PaymentIntentDocument>('payment_intents')
        .findOne({ tenantId: cmd.tenantId, idempotencyKey: cmd.idempotencyKey });
      if (!existing) throw err; // unreachable - the duplicate key IS this document
      return toDomainPaymentIntent(existing);
    }
  }

  /** CHECKOUT-SAGA.md §4.3: record the ambiguous attempt, then query the PSP
   *  by idempotency key rather than assuming failure and retrying blind. If
   *  the lookup itself comes back empty, the intent stays PENDING for a
   *  later reconciliation job (not built in this pass) to resolve. */
  private async reconcileAfterTimeout(intent: PaymentIntent): Promise<AuthorizeAndCaptureResult> {
    await this.recordPendingTransaction(intent);

    const outcome = await this.psp.findByIdempotencyKey(intent.idempotencyKey);
    if (!outcome) return { outcome: 'PENDING_RECONCILIATION', paymentId: intent.id };

    return this.finalize(intent, outcome);
  }

  private async finalize(intent: PaymentIntent, outcome: PspChargeOutcome): Promise<AuthorizeAndCaptureResult> {
    if (outcome.status === 'DECLINED') {
      intent.markFailed({ declineCode: outcome.declineCode, message: outcome.message });
      await this.persist(intent, 'FAILED', outcome);
      return { outcome: 'DECLINED', declineCode: outcome.declineCode, message: outcome.message };
    }

    intent.markCaptured({
      amountCaptured: intent.snapshot.amount,
      providerIntentId: outcome.providerIntentId,
      method: { brand: outcome.brand, last4: outcome.last4 },
    });
    await this.persist(intent, 'SUCCEEDED', outcome);
    return { outcome: 'CAPTURED', paymentId: intent.id, amountCaptured: intent.snapshot.amount };
  }

  /** Updates the intent, appends the transaction row, and writes the outbox
   *  event all in one transaction - ARCHITECTURE.md calls this out
   *  explicitly as the commit point of the whole system. */
  private async persist(intent: PaymentIntent, outcome: 'SUCCEEDED' | 'FAILED', charge: PspChargeOutcome): Promise<void> {
    const events = intent.pullEvents();
    await withOutbox(this.mongo, this.dbName, async (uow) => {
      await uow.collection<PaymentIntentDocument>('payment_intents').updateOne(
        { _id: intent.id, tenantId: intent.tenantId },
        { $set: toPaymentIntentDocument(intent) },
      );
      await this.insertTransaction(uow, intent, outcome, charge);
      return { result: undefined, events };
    });
  }

  private async recordPendingTransaction(intent: PaymentIntent): Promise<void> {
    await withOutbox(this.mongo, this.dbName, async (uow) => {
      await this.insertTransaction(uow, intent, 'PENDING', null);
      return { result: undefined, events: [] };
    });
  }

  private async insertTransaction(
    uow: UnitOfWork,
    intent: PaymentIntent,
    outcome: 'SUCCEEDED' | 'FAILED' | 'PENDING',
    charge: PspChargeOutcome | null,
  ): Promise<void> {
    const existing = await uow.collection<PaymentTransactionDocument>('payment_transactions').find({ paymentIntentId: intent.id }).toArray();
    const txn: PaymentTransactionDocument = {
      _id: newId('ptx'),
      tenantId: intent.tenantId,
      paymentIntentId: intent.id,
      sequence: existing.length + 1,
      type: 'CAPTURE',
      outcome,
      amount: intent.snapshot.amount,
      provider: intent.snapshot.provider,
      providerTransactionId: charge?.status === 'SUCCEEDED' ? charge.providerTransactionId : null,
      declineCode: charge?.status === 'DECLINED' ? charge.declineCode : null,
      message: charge?.status === 'DECLINED' ? charge.message : null,
      occurredAt: new Date(),
    };
    await uow.collection<PaymentTransactionDocument>('payment_transactions').insertOne(txn);
  }
}
