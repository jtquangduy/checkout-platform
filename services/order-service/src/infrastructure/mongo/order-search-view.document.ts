import type { TenantScoped } from '@platform/kernel';
import type { OrderStatus } from '../../domain/order/order.state-machine.js';

export interface OrderSearchViewDocument extends TenantScoped {
  _id: string;
  tenantId: string;
  name: string;
  nameNormalized: string;
  nameTokens: string[];
  status: OrderStatus;
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}
