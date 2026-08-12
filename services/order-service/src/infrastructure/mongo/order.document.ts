import type { TenantScoped } from '@platform/kernel';
import type { OrderStatus } from '../../domain/order/order.state-machine.js';
import type { OrderItem } from '../../domain/order/order-item.entity.js';

export interface OrderDocument extends TenantScoped {
  _id: string;
  tenantId: string;
  name: string;
  nameNormalized: string;
  nameTokens: string[];
  status: OrderStatus;
  items: OrderItem[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
