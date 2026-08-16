import type { TenantScoped } from '@platform/kernel';
import type { Currency, Money } from '@platform/contracts';

export interface PriceBookEntryDocument {
  skuCode: string;
  description: string;
  unitPrice: Money;
}

export interface VolumeTierDocument {
  minUnits: number;
  discountBps: number;
}

export interface TaxProfileDocument {
  code: string;
  rate: number;
  reverseCharge: boolean;
}

export interface PriceBookDocument extends TenantScoped {
  _id: string;
  tenantId: string;
  name: string;
  version: number;
  currency: Currency;
  status: 'ACTIVE' | 'DRAFT' | 'RETIRED';
  effectiveFrom: Date;
  effectiveTo: Date | null;
  prices: PriceBookEntryDocument[];
  orderVolumeTiers: VolumeTierDocument[];
  taxProfile: TaxProfileDocument;
  createdAt: Date;
  updatedAt: Date;
}
