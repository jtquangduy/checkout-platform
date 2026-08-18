import type { Db } from 'mongodb';

export async function ensurePaymentIndexes(db: Db): Promise<void> {
  // Guard #1 (DATA-INTEGRITY.md §7): one specific retry can never produce two writes.
  await db.collection('payment_intents').createIndex(
    { tenantId: 1, idempotencyKey: 1 },
    { unique: true, name: 'uq_idempotency_key' },
  );

  // Guard #3, the last-resort backstop: at most one LIVE payment per order,
  // enforced by the database even if a bug bypassed the first two guards.
  // PENDING is deliberately excluded, same as DATA-MODEL.md's own partial
  // filter excludes the in-flight AUTHORIZING state - the constraint is
  // enforced at the moment a document's status actually ENTERS the live
  // set, not at intent-creation time.
  await db.collection('payment_intents').createIndex(
    { orderId: 1 },
    {
      unique: true,
      partialFilterExpression: { status: { $in: ['CAPTURED', 'REFUNDED'] } },
      name: 'uq_one_live_payment_per_order',
    },
  );

  await db.collection('payment_transactions').createIndex(
    { paymentIntentId: 1, sequence: 1 },
    { unique: true },
  );
}
