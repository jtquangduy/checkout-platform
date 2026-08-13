import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { newId, OrderId, TenantId } from '@platform/contracts';
import { ReserveForCheckoutUseCase } from '../../src/application/reserve-for-checkout.usecase.js';
import type { OrderDocument } from '../../src/infrastructure/mongo/order.document.js';
import type { OrderStatus } from '../../src/domain/order/order.state-machine.js';

const MONGO_URI =
  process.env.MONGO_TEST_URI ??
  'mongodb://admin:devpassword@localhost:27017/?replicaSet=rs0&directConnection=true&authSource=admin';
const DB_NAME = 'order_service_reserve_test';

let client: MongoClient;
let db: Db;
let reserveForCheckout: ReserveForCheckoutUseCase;

beforeAll(async () => {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  reserveForCheckout = new ReserveForCheckoutUseCase(client, DB_NAME);
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

// Seeded directly rather than driving the Order aggregate through
// DRAFT -> PRICING -> READY_FOR_CHECKOUT — the use cases for those
// transitions don't exist yet. This isolates the reservation CAS, which is
// this step's only concern.
async function seedOrder(params: { tenantId: string; status?: OrderStatus; version?: number }): Promise<string> {
  const id = OrderId.parse(newId('ord'));
  const now = new Date();
  const doc: OrderDocument = {
    _id: id,
    tenantId: params.tenantId,
    name: 'Seeded',
    nameNormalized: 'seeded',
    nameTokens: ['seeded'],
    status: params.status ?? 'READY_FOR_CHECKOUT',
    items: [],
    version: params.version ?? 0,
    checkout: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection<OrderDocument>('orders').insertOne(doc);
  return id;
}

describe('ReserveForCheckoutUseCase', () => {
  it('reserves a READY_FOR_CHECKOUT order and bumps its version', async () => {
    const tenantId = TenantId.parse(newId('ten'));
    const orderId = await seedOrder({ tenantId });

    const result = await reserveForCheckout.execute({
      tenantId, orderId, expectedVersion: 0, checkoutSessionId: 'sess_1', holdTtlMs: 900_000,
    });

    expect(result).toEqual({ outcome: 'OK', newVersion: 1 });

    const doc = await db.collection<OrderDocument>('orders').findOne({ _id: orderId });
    expect(doc?.status).toBe('CHECKOUT_PENDING');
    expect(doc?.checkout?.sessionId).toBe('sess_1');
  });

  it('exactly one of two concurrent reservation attempts wins; the loser sees ALREADY_RESERVED', async () => {
    const tenantId = TenantId.parse(newId('ten'));
    const orderId = await seedOrder({ tenantId });

    const [a, b] = await Promise.all([
      reserveForCheckout.execute({ tenantId, orderId, expectedVersion: 0, checkoutSessionId: 'sess_A', holdTtlMs: 900_000 }),
      reserveForCheckout.execute({ tenantId, orderId, expectedVersion: 0, checkoutSessionId: 'sess_B', holdTtlMs: 900_000 }),
    ]);

    expect([a.outcome, b.outcome].sort()).toEqual(['ALREADY_RESERVED', 'OK']);

    const loser = a.outcome === 'ALREADY_RESERVED' ? a : b;
    if (loser.outcome === 'ALREADY_RESERVED') {
      expect(['sess_A', 'sess_B']).toContain(loser.reservedBySession);
    }

    // Exactly one increment landed, not two — the loser's write never happened.
    const doc = await db.collection<OrderDocument>('orders').findOne({ _id: orderId });
    expect(doc?.version).toBe(1);
  });

  it('rejects a stale expectedVersion with VERSION_CONFLICT', async () => {
    const tenantId = TenantId.parse(newId('ten'));
    const orderId = await seedOrder({ tenantId, version: 5 });

    const result = await reserveForCheckout.execute({
      tenantId, orderId, expectedVersion: 0, checkoutSessionId: 'sess_1', holdTtlMs: 900_000,
    });

    expect(result).toEqual({ outcome: 'VERSION_CONFLICT', currentVersion: 5 });
  });

  it('returns NOT_FOUND for an unknown order id', async () => {
    const tenantId = TenantId.parse(newId('ten'));

    const result = await reserveForCheckout.execute({
      tenantId, orderId: OrderId.parse(newId('ord')), expectedVersion: 0, checkoutSessionId: 'sess_1', holdTtlMs: 900_000,
    });

    expect(result).toEqual({ outcome: 'NOT_FOUND' });
  });

  it('returns ALREADY_PAID for an order already past checkout, without modifying it', async () => {
    const tenantId = TenantId.parse(newId('ten'));
    const orderId = await seedOrder({ tenantId, status: 'IN_PRODUCTION', version: 3 });

    const result = await reserveForCheckout.execute({
      tenantId, orderId, expectedVersion: 3, checkoutSessionId: 'sess_1', holdTtlMs: 900_000,
    });

    expect(result).toEqual({ outcome: 'ALREADY_PAID' });

    const doc = await db.collection<OrderDocument>('orders').findOne({ _id: orderId });
    expect(doc?.version).toBe(3); // untouched
  });
});
