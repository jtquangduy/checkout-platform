import { OrderId, TenantId } from '@platform/contracts';
import { Order } from '../../domain/order/order.aggregate.js';
import type { OrderDocument } from './order.document.js';

export function toOrderDocument(order: Order): OrderDocument {
  const s = order.snapshot;
  return {
    _id: s.id,
    tenantId: s.tenantId,
    name: s.name,
    nameNormalized: s.nameNormalized,
    nameTokens: s.nameTokens,
    status: s.status,
    items: [...s.items],
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function toDomainOrder(doc: OrderDocument): Order {
  return Order.reconstitute({
    id: OrderId.parse(doc._id),
    tenantId: TenantId.parse(doc.tenantId),
    name: doc.name,
    nameNormalized: doc.nameNormalized,
    nameTokens: doc.nameTokens,
    status: doc.status,
    items: doc.items,
    version: doc.version,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}
