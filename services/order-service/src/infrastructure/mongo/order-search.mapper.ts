import type { Order } from '../../domain/order/order.aggregate.js';
import type { OrderSearchViewDocument } from './order-search-view.document.js';

export function toSearchViewDocument(order: Order): OrderSearchViewDocument {
  const s = order.snapshot;
  return {
    _id: s.id,
    tenantId: s.tenantId,
    name: s.name,
    nameNormalized: s.nameNormalized,
    nameTokens: s.nameTokens,
    status: s.status,
    itemCount: s.items.length,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}
