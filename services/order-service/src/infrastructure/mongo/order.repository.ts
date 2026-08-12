import type { Collection } from 'mongodb';
import { TenantScopedRepository } from '@platform/kernel';
import { Order } from '../../domain/order/order.aggregate.js';
import { toDomainOrder } from './order.mapper.js';
import type { OrderDocument } from './order.document.js';

export class OrderRepository extends TenantScopedRepository<OrderDocument> {
  constructor(col: Collection<OrderDocument>) {
    super(col);
  }

  async findById(id: string): Promise<Order | null> {
    const doc = await this.findOne({ _id: id });
    return doc ? toDomainOrder(doc) : null;
  }
}
