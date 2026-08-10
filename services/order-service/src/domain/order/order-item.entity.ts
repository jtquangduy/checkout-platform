import type { Money } from '@platform/contracts';

export interface OrderItem {
  id: string;
  assetId: string;
  filename: string;
  skuCode: string;
  quantity: number;
  unitPrice: Money;
  lineTotal: Money;
}
