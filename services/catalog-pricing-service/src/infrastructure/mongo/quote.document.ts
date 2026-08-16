import type { TenantScoped } from '@platform/kernel';
import type { Money } from '@platform/contracts';
import type { QuoteLine } from '../../domain/pricing/pricing-engine.js';

export interface QuoteDocument extends TenantScoped {
  _id: string;
  tenantId: string;
  orderId: string;
  priceBookId: string;
  priceBookVersion: number;
  lines: QuoteLine[];
  subtotal: Money;
  tax: Money;
  total: Money;
  integrityHash: string;
  expiresAt: Date;
  createdAt: Date;
}
