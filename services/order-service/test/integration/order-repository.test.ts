import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { RequestContext } from '@platform/kernel';
import { newId, TenantId } from '@platform/contracts';
import { CreateOrderUseCase } from '../../src/application/create-order.usecase.js';
import { OrderRepository } from '../../src/infrastructure/mongo/order.repository.js';
import { OrderSearchRepository } from '../../src/infrastructure/mongo/order-search.repository.js';
import { ensureOrderIndexes } from '../../src/infrastructure/mongo/ensure-indexes.js';
import type { OrderDocument } from '../../src/infrastructure/mongo/order.document.js';
import type { OrderSearchViewDocument } from '../../src/infrastructure/mongo/order-search-view.document.js';

const MONGO_URI =
  process.env.MONGO_TEST_URI ??
  'mongodb://admin:devpassword@localhost:27017/?replicaSet=rs0&directConnection=true&authSource=admin';
const DB_NAME = 'order_service_test';

let client: MongoClient;
let db: Db;
let createOrder: CreateOrderUseCase;
let orders: OrderRepository;
let searchView: OrderSearchRepository;

function ctx(tenantId: TenantId) {
  return { tenantId, userId: 'u1', roles: [], correlationId: 'c1' };
}

beforeAll(async () => {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await ensureOrderIndexes(db);

  createOrder = new CreateOrderUseCase(client, DB_NAME);
  orders = new OrderRepository(db.collection<OrderDocument>('orders'));
  searchView = new OrderSearchRepository(db.collection<OrderSearchViewDocument>('order_search_view'));
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

describe('CreateOrderUseCase', () => {
  it('atomically writes the order AND the search view in one transaction', async () => {
    const tenantId = TenantId.parse(newId('ten'));

    const order = await RequestContext.run(ctx(tenantId), () =>
      createOrder.execute({ tenantId, name: 'Nike SS26 Apparel — Batch 04' }),
    );

    const foundOrder = await RequestContext.run(ctx(tenantId), () => orders.findById(order.id));
    expect(foundOrder?.status).toBe('DRAFT');

    const searchResults = await RequestContext.run(ctx(tenantId), () => searchView.search('nike'));
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0]?._id).toBe(order.id);
  });

  it('search is prefix-matched per token and is tenant-isolated', async () => {
    const tenantA = TenantId.parse(newId('ten'));
    const tenantB = TenantId.parse(newId('ten'));

    await RequestContext.run(ctx(tenantA), () => createOrder.execute({ tenantId: tenantA, name: 'Adidas Summer Batch' }));
    await RequestContext.run(ctx(tenantB), () => createOrder.execute({ tenantId: tenantB, name: 'Adidas Winter Batch' }));

    const resultsForA = await RequestContext.run(ctx(tenantA), () => searchView.search('adi'));
    expect(resultsForA).toHaveLength(1);
    expect(resultsForA[0]?.name).toBe('Adidas Summer Batch');
  });
});
