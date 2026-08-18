import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { newId, TenantId, type Money, type TenantId as TenantIdType } from '@platform/contracts';
import { AuthorizeAndCaptureUseCase, type AuthorizeAndCaptureCommand } from '../../src/application/authorize-and-capture.usecase.js';
import { MockPspGateway } from '../../src/infrastructure/psp/mock-psp.gateway.js';
import { ensurePaymentIndexes } from '../../src/infrastructure/mongo/ensure-indexes.js';
import type { PaymentIntentDocument } from '../../src/infrastructure/mongo/payment-intent.document.js';
import type { PaymentTransactionDocument } from '../../src/infrastructure/mongo/payment-transaction.document.js';

const MONGO_URI =
  process.env.MONGO_TEST_URI ??
  'mongodb://admin:devpassword@localhost:27017/?replicaSet=rs0&directConnection=true&authSource=admin';
const DB_NAME = 'payment_service_test';

let client: MongoClient;
let db: Db;
let psp: MockPspGateway;
let authorizeAndCapture: AuthorizeAndCaptureUseCase;

beforeAll(async () => {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await ensurePaymentIndexes(db);
});

beforeEach(() => {
  psp = new MockPspGateway();
  authorizeAndCapture = new AuthorizeAndCaptureUseCase(client, DB_NAME, psp);
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

function baseCommand(overrides: Partial<AuthorizeAndCaptureCommand> = {}): AuthorizeAndCaptureCommand {
  const tenantId: TenantIdType = overrides.tenantId ?? TenantId.parse(newId('ten'));
  return {
    tenantId,
    orderId: newId('ord'),
    checkoutSessionId: newId('cko'),
    idempotencyKey: `${newId('cko')}:CAPTURE_PAYMENT`,
    amount: { amount: 10_000, currency: 'GBP' } as Money,
    paymentMethodToken: 'tok_visa_success',
    ...overrides,
  };
}

describe('AuthorizeAndCaptureUseCase', () => {
  it('captures a successful charge and writes the intent + transaction atomically', async () => {
    const cmd = baseCommand();
    const result = await authorizeAndCapture.execute(cmd);

    expect(result).toMatchObject({ outcome: 'CAPTURED', amountCaptured: cmd.amount });

    const intentDoc = await db.collection<PaymentIntentDocument>('payment_intents').findOne({ idempotencyKey: cmd.idempotencyKey });
    expect(intentDoc?.status).toBe('CAPTURED');

    const txns = await db.collection<PaymentTransactionDocument>('payment_transactions').find({ paymentIntentId: intentDoc!._id }).toArray();
    expect(txns).toHaveLength(1);
    expect(txns[0]?.outcome).toBe('SUCCEEDED');
  });

  it('records a decline as FAILED without throwing', async () => {
    const cmd = baseCommand({ paymentMethodToken: 'tok_visa_declined' });
    const result = await authorizeAndCapture.execute(cmd);

    expect(result).toEqual({ outcome: 'DECLINED', declineCode: 'card_declined', message: 'Your card was declined.' });

    const intentDoc = await db.collection<PaymentIntentDocument>('payment_intents').findOne({ idempotencyKey: cmd.idempotencyKey });
    expect(intentDoc?.status).toBe('FAILED');
  });

  it('a retry with the same idempotency key returns ALREADY_CAPTURED and writes nothing new', async () => {
    const cmd = baseCommand();
    const first = await authorizeAndCapture.execute(cmd);
    const second = await authorizeAndCapture.execute(cmd);

    expect(first.outcome).toBe('CAPTURED');
    expect(second.outcome).toBe('ALREADY_CAPTURED');

    const intents = await db.collection<PaymentIntentDocument>('payment_intents').find({ idempotencyKey: cmd.idempotencyKey }).toArray();
    expect(intents).toHaveLength(1); // the unique index did its job

    const txns = await db.collection<PaymentTransactionDocument>('payment_transactions').find({ paymentIntentId: intents[0]!._id }).toArray();
    expect(txns).toHaveLength(1); // no second CAPTURE row from the retry
  });

  it('reconciles an ambiguous PSP timeout by querying, not guessing (CHECKOUT-SAGA.md §4.3)', async () => {
    const cmd = baseCommand({ paymentMethodToken: 'tok_visa_timeout' });
    const result = await authorizeAndCapture.execute(cmd);

    // The PSP call itself timed out, but the reconciliation lookup inside
    // the SAME execute() call finds it actually succeeded - the caller sees
    // a normal CAPTURED result, never the timeout.
    expect(result.outcome).toBe('CAPTURED');

    const intentDoc = await db.collection<PaymentIntentDocument>('payment_intents').findOne({ idempotencyKey: cmd.idempotencyKey });
    expect(intentDoc?.status).toBe('CAPTURED');

    const txns = await db
      .collection<PaymentTransactionDocument>('payment_transactions')
      .find({ paymentIntentId: intentDoc!._id })
      .sort({ sequence: 1 })
      .toArray();
    expect(txns.map((t) => t.outcome)).toEqual(['PENDING', 'SUCCEEDED']); // the timeout attempt is never erased
  });

  it('stays PENDING for later reconciliation when even the lookup is unavailable', async () => {
    const cmd = baseCommand({ paymentMethodToken: 'tok_visa_timeout_unresolvable' });
    const result = await authorizeAndCapture.execute(cmd);

    expect(result.outcome).toBe('PENDING_RECONCILIATION');

    const intentDoc = await db.collection<PaymentIntentDocument>('payment_intents').findOne({ idempotencyKey: cmd.idempotencyKey });
    expect(intentDoc?.status).toBe('PENDING');
  });

  it('enforces uq_one_live_payment_per_order even across two different idempotency keys', async () => {
    const tenantId = TenantId.parse(newId('ten'));
    const orderId = newId('ord');

    const first = await authorizeAndCapture.execute(baseCommand({ tenantId, orderId }));
    expect(first.outcome).toBe('CAPTURED');

    // A different session/idempotency key attempting to capture the SAME
    // order - the three-guard model's last-resort backstop (DATA-INTEGRITY
    // §7), even if something upstream let a second attempt through.
    await expect(authorizeAndCapture.execute(baseCommand({ tenantId, orderId }))).rejects.toThrow();
  });
});
