import { newId, type OrderId, type TenantId } from '@platform/contracts';
import type { DomainEvent } from '@platform/kernel';
import type { OrderStatus } from './order.state-machine.js';

export interface OrderStatusChangedPayload {
  orderId: OrderId;
  from: OrderStatus;
  to: OrderStatus;
}

export function orderStatusChangedEvent(
  orderId: OrderId,
  tenantId: TenantId,
  from: OrderStatus,
  to: OrderStatus,
): DomainEvent<OrderStatusChangedPayload> {
  return {
    messageId: newId('evt'),
    aggregateType: 'Order',
    aggregateId: orderId,
    type: 'order.status_changed',
    version: 1,
    tenantId,
    payload: { orderId, from, to },
    occurredAt: new Date(),
  };
}
