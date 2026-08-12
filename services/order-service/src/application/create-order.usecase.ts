import type { MongoClient } from 'mongodb';
import { withOutbox } from '@platform/kernel';
import type { TenantId } from '@platform/contracts';
import { Order } from '../domain/order/order.aggregate.js';
import { toOrderDocument } from '../infrastructure/mongo/order.mapper.js';
import { toSearchViewDocument } from '../infrastructure/mongo/order-search.mapper.js';
import type { OrderDocument } from '../infrastructure/mongo/order.document.js';
import type { OrderSearchViewDocument } from '../infrastructure/mongo/order-search-view.document.js';

export interface CreateOrderCommand {
  tenantId: TenantId;
  name: string;
}

export class CreateOrderUseCase {
  constructor(
    private readonly mongo: MongoClient,
    private readonly dbName: string,
  ) {}

  async execute(cmd: CreateOrderCommand): Promise<Order> {
    const order = Order.create(cmd);

    // No events published yet — nothing consumes "order created" in this
    // phase. withOutbox with an empty events array is just an atomic
    // multi-collection transaction, reusing Step 5's session-safety net.
    await withOutbox(this.mongo, this.dbName, async (uow) => {
      await uow.collection<OrderDocument>('orders').insertOne(toOrderDocument(order));
      await uow.collection<OrderSearchViewDocument>('order_search_view').insertOne(toSearchViewDocument(order));
      return { result: undefined, events: [] };
    });

    return order;
  }
}
